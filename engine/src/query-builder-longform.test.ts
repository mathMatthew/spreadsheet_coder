import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { QueryBuilder } from './query-builder'
import { makeSchema, queryAll, exec, findRow, rollupRows } from './test-helpers'
import duckdb from 'duckdb'

// ── Long-form test data ─────────────────────────────────────────────
//
// Same entities and time periods as the wide-form tests, but data is in
// long-form: one value column ("amount") + a qualifier dimension ("metric")
// that identifies what the value represents.
//
//   region | country | month      | metric    | amount
//   APAC   | AU      | 2025-01-01 | Revenue   | 100
//   APAC   | AU      | 2025-02-01 | Revenue   | 200
//   ...
//
// Flow declaration: metric="Inventory" is stock (weighted_avg), everything else is flow.
//
// Expected results per metric (matching wide-form test expectations):
//   Revenue (flow SUM): AU=600, JP=1500, UK=60, DE=150
//   Inventory (stock weighted_avg, equal periods): AU=50, JP=80, UK=30, DE=100

describe('QueryBuilder long-form mode', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        country VARCHAR,
        month DATE,
        metric VARCHAR,
        amount DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', DATE '2025-01-01', 'Revenue',   100),
        ('APAC', 'AU', DATE '2025-02-01', 'Revenue',   200),
        ('APAC', 'AU', DATE '2025-03-01', 'Revenue',   300),
        ('APAC', 'AU', DATE '2025-01-01', 'Inventory',  50),
        ('APAC', 'AU', DATE '2025-02-01', 'Inventory',  60),
        ('APAC', 'AU', DATE '2025-03-01', 'Inventory',  40),
        ('APAC', 'JP', DATE '2025-01-01', 'Revenue',   400),
        ('APAC', 'JP', DATE '2025-02-01', 'Revenue',   500),
        ('APAC', 'JP', DATE '2025-03-01', 'Revenue',   600),
        ('APAC', 'JP', DATE '2025-01-01', 'Inventory',  80),
        ('APAC', 'JP', DATE '2025-02-01', 'Inventory',  70),
        ('APAC', 'JP', DATE '2025-03-01', 'Inventory',  90),
        ('EMEA', 'UK', DATE '2025-01-01', 'Revenue',    10),
        ('EMEA', 'UK', DATE '2025-02-01', 'Revenue',    20),
        ('EMEA', 'UK', DATE '2025-03-01', 'Revenue',    30),
        ('EMEA', 'UK', DATE '2025-01-01', 'Inventory',  30),
        ('EMEA', 'UK', DATE '2025-02-01', 'Inventory',  30),
        ('EMEA', 'UK', DATE '2025-03-01', 'Inventory',  30),
        ('EMEA', 'DE', DATE '2025-01-01', 'Revenue',    40),
        ('EMEA', 'DE', DATE '2025-02-01', 'Revenue',    50),
        ('EMEA', 'DE', DATE '2025-03-01', 'Revenue',    60),
        ('EMEA', 'DE', DATE '2025-01-01', 'Inventory', 100),
        ('EMEA', 'DE', DATE '2025-02-01', 'Inventory', 100),
        ('EMEA', 'DE', DATE '2025-03-01', 'Inventory', 100);
    `)
  })

  afterAll(() => {
    db?.close()
  })

  // ── Hidden time dim: qualifier on rows, detail values ─────────────

  it('long-form: detail values — stock gets weighted_avg, flow gets SUM', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'metric', sourceField: 'metric' },
      ],
      measures: [
        { id: 'amount', sourceField: 'amount', aggregation: 'sum' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
      flowDeclarations: [
        { dimensionId: 'metric', valueColumn: 'amount', stockValues: ['Inventory'], flowValues: ['Revenue'] },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country', 'metric'],
      measures: ['amount'],
    })

    const rows = await queryAll(conn, result.sql)
    const data = rollupRows(rows)

    // Revenue (flow): SUM across time
    const auRevenue = findRow(data, { country: 'AU', metric: 'Revenue' })
    expect(auRevenue.amount).toBeCloseTo(600)

    const jpRevenue = findRow(data, { country: 'JP', metric: 'Revenue' })
    expect(jpRevenue.amount).toBeCloseTo(1500)

    // Inventory (stock): weighted_avg across time (equal periods = simple average)
    const auInventory = findRow(data, { country: 'AU', metric: 'Inventory' })
    expect(auInventory.amount).toBeCloseTo(50)  // (50+60+40)/3

    const jpInventory = findRow(data, { country: 'JP', metric: 'Inventory' })
    expect(jpInventory.amount).toBeCloseTo(80)  // (80+70+90)/3

    // Country subtotals (metric collapsed): SUM of correctly-aggregated values
    // AU: Revenue(600) + Inventory(50) = 650
    const auTotal = findRow(data, { country: 'AU', metric: null })
    expect(auTotal.amount).toBeCloseTo(650)

    // Grand total: all countries, all metrics
    // AU(650) + JP(1580) + UK(90) + DE(250) = 2570
    const total = findRow(data, { country: null, metric: null })
    expect(total.amount).toBeCloseTo(2570)
  })

  // ── No time dims: everything SUMs ─────────────────────────────────

  it('long-form without time dims: all values SUM normally', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'metric', sourceField: 'metric' },
      ],
      measures: [
        { id: 'amount', sourceField: 'amount', aggregation: 'sum' },
      ],
      // No timeDimensions — stock/flow is inert
      flowDeclarations: [
        { dimensionId: 'metric', valueColumn: 'amount', stockValues: ['Inventory'], flowValues: ['Revenue'] },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'metric'],
      measures: ['amount'],
    })

    const rows = await queryAll(conn, result.sql)
    const data = rollupRows(rows)

    // Without time dims, everything just SUMs (stock/flow distinction is inert)
    const apacRevenue = findRow(data, { region: 'APAC', metric: 'Revenue' })
    expect(apacRevenue.amount).toBeCloseTo(2100)

    // Inventory SUMs too: 50+60+40+80+70+90 = 390
    const apacInventory = findRow(data, { region: 'APAC', metric: 'Inventory' })
    expect(apacInventory.amount).toBeCloseTo(390)
  })

  // ── Qualifier not on an axis: hidden in middle, collapsed in outer ──

  it('long-form: qualifier not on rows/cols — time aggregation still correct', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'metric', sourceField: 'metric' },
      ],
      measures: [
        { id: 'amount', sourceField: 'amount', aggregation: 'sum' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
      flowDeclarations: [
        { dimensionId: 'metric', valueColumn: 'amount', stockValues: ['Inventory'], flowValues: ['Revenue'] },
      ],
    })

    const qb = new QueryBuilder(schema)
    // metric NOT on rows or columns — auto-added to middle CTE GROUP BY
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['amount'],
    })

    const rows = await queryAll(conn, result.sql)
    const data = rollupRows(rows)

    // AU: Revenue=600 (SUM) + Inventory=50 (avg) = 650
    const au = findRow(data, { country: 'AU' })
    expect(au.amount).toBeCloseTo(650)

    // JP: Revenue=1500 (SUM) + Inventory=80 (avg) = 1580
    const jp = findRow(data, { country: 'JP' })
    expect(jp.amount).toBeCloseTo(1580)

    // Grand total
    const total = findRow(data, { country: null })
    expect(total.amount).toBeCloseTo(2570)  // 650+1580+90+250
  })

  // ── Day-weighted stock ────────────────────────────────────────────

  it('long-form with day weighting: stock values weight by days in month', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'metric', sourceField: 'metric' },
      ],
      measures: [
        { id: 'amount', sourceField: 'amount', aggregation: 'sum' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
      flowDeclarations: [
        { dimensionId: 'metric', valueColumn: 'amount', stockValues: ['Inventory'], flowValues: ['Revenue'] },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country', 'metric'],
      measures: ['amount'],
    })

    const rows = await queryAll(conn, result.sql)
    const data = rollupRows(rows)

    // Revenue still SUMs
    const auRevenue = findRow(data, { country: 'AU', metric: 'Revenue' })
    expect(auRevenue.amount).toBeCloseTo(600)

    // Inventory gets day-weighted average:
    // Jan=31 days, Feb=28 days, Mar=31 days, total=90 days
    // AU: (50*31 + 60*28 + 40*31) / 90 = (1550+1680+1240)/90 = 4470/90 = 49.667
    const auInventory = findRow(data, { country: 'AU', metric: 'Inventory' })
    expect(auInventory.amount).toBeCloseTo(4470 / 90, 1)
  })

  // ── Measure without flow declaration: plain SUM ───────────────────

  it('long-form: measure without flow declaration uses plain SUM', async () => {
    // Add a second measure column that has no flow declaration
    await exec(conn, `
      CREATE TABLE data2 AS
      SELECT *, amount * 2 AS amount2 FROM data;
    `)

    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'metric', sourceField: 'metric' },
      ],
      measures: [
        { id: 'amount', sourceField: 'amount', aggregation: 'sum' },
        { id: 'amount2', sourceField: 'amount2', aggregation: 'sum' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
      flowDeclarations: [
        // Only amount has a declaration; amount2 does not
        { dimensionId: 'metric', valueColumn: 'amount', stockValues: ['Inventory'], flowValues: ['Revenue'] },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country', 'metric'],
      measures: ['amount', 'amount2'],
      source: 'data2',
    })

    const rows = await queryAll(conn, result.sql)
    const data = rollupRows(rows)

    // amount: Inventory uses weighted_avg
    const auInventory = findRow(data, { country: 'AU', metric: 'Inventory' })
    expect(auInventory.amount).toBeCloseTo(50)  // avg

    // amount2: no flow declaration → plain SUM regardless of metric value
    // AU Inventory: (50+60+40)*2 = 300
    expect(auInventory.amount2).toBeCloseTo(300)

    await exec(conn, `DROP TABLE data2`)
  })
})
