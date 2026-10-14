import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { QueryBuilder, expandDimsVariable, injectGroupingPartition, neutralizeUngroupedGrouping, resolveDimExprForSchema, type QuerySchema } from './query-builder'
import type { DimensionDefinition, MeasureDefinition, TimeDimensionConfig } from './model'
import { SEP, CROSS_SEP } from './model'
import duckdb from 'duckdb'
import { makeSchema, queryAll, exec, normalize, findRow, rollupRows } from './test-helpers'

// ── Test data ────────────────────────────────────────────────────────
//
// 2 regions × 2 countries × 3 months, with values chosen for easy mental math.
//
//   region | country | month      | revenue | inventory | balance
//   APAC   | AU      | 2025-01-01 | 100     | 50        | 1000
//   APAC   | AU      | 2025-02-01 | 200     | 60        | 1100
//   APAC   | AU      | 2025-03-01 | 300     | 40        | 1200
//   APAC   | JP      | 2025-01-01 | 400     | 80        | 2000
//   APAC   | JP      | 2025-02-01 | 500     | 70        | 2200
//   APAC   | JP      | 2025-03-01 | 600     | 90        | 2400
//   EMEA   | UK      | 2025-01-01 | 10      | 30        | 500
//   EMEA   | UK      | 2025-02-01 | 20      | 30        | 600
//   EMEA   | UK      | 2025-03-01 | 30      | 30        | 700
//   EMEA   | DE      | 2025-01-01 | 40      | 100       | 3000
//   EMEA   | DE      | 2025-02-01 | 50      | 100       | 3200
//   EMEA   | DE      | 2025-03-01 | 60      | 100       | 3500
//
// Hand-computed expected results:
//
// Revenue (flow SUM — total across time, SUM for rollup):
//   AU=600, JP=1500, UK=60, DE=150, APAC=2100, EMEA=210, Total=2310
//
// Inventory (stock weighted_avg, equal periods — avg across time, SUM for rollup):
//   AU=(50+60+40)/3=50, JP=(80+70+90)/3=80, UK=30, DE=100
//   APAC=50+80=130, EMEA=30+100=130, Total=260
//
// Balance (stock EOP — last period's value, SUM for rollup):
//   AU=1200, JP=2400, UK=700, DE=3500
//   APAC=1200+2400=3600, EMEA=700+3500=4200, Total=7800

describe('QueryBuilder rollup against real DuckDB', () => {
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
        revenue DOUBLE,
        inventory DOUBLE,
        balance DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', DATE '2025-01-01', 100, 50, 1000),
        ('APAC', 'AU', DATE '2025-02-01', 200, 60, 1100),
        ('APAC', 'AU', DATE '2025-03-01', 300, 40, 1200),
        ('APAC', 'JP', DATE '2025-01-01', 400, 80, 2000),
        ('APAC', 'JP', DATE '2025-02-01', 500, 70, 2200),
        ('APAC', 'JP', DATE '2025-03-01', 600, 90, 2400),
        ('EMEA', 'UK', DATE '2025-01-01', 10,  30, 500),
        ('EMEA', 'UK', DATE '2025-02-01', 20,  30, 600),
        ('EMEA', 'UK', DATE '2025-03-01', 30,  30, 700),
        ('EMEA', 'DE', DATE '2025-01-01', 40,  100, 3000),
        ('EMEA', 'DE', DATE '2025-02-01', 50,  100, 3200),
        ('EMEA', 'DE', DATE '2025-03-01', 60,  100, 3500);
    `)
  })

  afterAll(() => {
    db?.close()
  })

  // ── Stock weighted_avg: rollup SUMs time-averaged values ─────────

  it('stock weighted_avg: country values are time-averaged, region totals are SUMs of those', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory'],
    })

    const rows = await queryAll(conn, result.sql)

    // Country-level: average across 3 months
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).inventory).toBeCloseTo(50)
    expect(findRow(rows, { region: 'APAC', country: 'JP' }).inventory).toBeCloseTo(80)
    expect(findRow(rows, { region: 'EMEA', country: 'UK' }).inventory).toBeCloseTo(30)
    expect(findRow(rows, { region: 'EMEA', country: 'DE' }).inventory).toBeCloseTo(100)

    // Region-level: SUM of country averages, NOT average of all rows
    expect(findRow(rows, { region: 'APAC', country: null }).inventory).toBeCloseTo(130)
    expect(findRow(rows, { region: 'EMEA', country: null }).inventory).toBeCloseTo(130)

    // Grand total: SUM of all country averages
    expect(findRow(rows, { region: null, country: null }).inventory).toBeCloseTo(260)
  })

  // ── Stock EOP: rollup SUMs end-of-period values ──────────────────

  it('stock eop: country values are last-period, region totals are SUMs of those', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Country-level: March (latest) balance
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).balance).toBeCloseTo(1200)
    expect(findRow(rows, { region: 'APAC', country: 'JP' }).balance).toBeCloseTo(2400)
    expect(findRow(rows, { region: 'EMEA', country: 'UK' }).balance).toBeCloseTo(700)
    expect(findRow(rows, { region: 'EMEA', country: 'DE' }).balance).toBeCloseTo(3500)

    // Region-level: SUM of country EOP values
    expect(findRow(rows, { region: 'APAC', country: null }).balance).toBeCloseTo(3600)
    expect(findRow(rows, { region: 'EMEA', country: null }).balance).toBeCloseTo(4200)

    // Grand total
    expect(findRow(rows, { region: null, country: null }).balance).toBeCloseTo(7800)
  })

  // ── Mixed flow + stock in same query ─────────────────────────────

  it('mixed flow + stock: each measure type rolls up correctly', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue', 'inventory', 'balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Country-level
    const au = findRow(rows, { region: 'APAC', country: 'AU' })
    expect(au.revenue).toBeCloseTo(600)       // flow: sum across months
    expect(au.inventory).toBeCloseTo(50)      // weighted_avg: avg across months
    expect(au.balance).toBeCloseTo(1200)      // eop: March value

    // Region-level
    const apac = findRow(rows, { region: 'APAC', country: null })
    expect(apac.revenue).toBeCloseTo(2100)    // flow: 600+1500
    expect(apac.inventory).toBeCloseTo(130)   // stock: 50+80, NOT (50+80)/2
    expect(apac.balance).toBeCloseTo(3600)    // eop: 1200+2400

    // Grand total
    const total = findRow(rows, { region: null, country: null })
    expect(total.revenue).toBeCloseTo(2310)   // flow: 2100+210
    expect(total.inventory).toBeCloseTo(260)  // stock: 130+130
    expect(total.balance).toBeCloseTo(7800)   // eop: 3600+4200
  })

  // ── Single dimension stock rollup ────────────────────────────────

  it('stock weighted_avg with one row dimension: total = sum of entity averages', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['inventory'],
    })

    const rows = await queryAll(conn, result.sql)

    expect(findRow(rows, { country: 'AU' }).inventory).toBeCloseTo(50)
    expect(findRow(rows, { country: 'JP' }).inventory).toBeCloseTo(80)
    expect(findRow(rows, { country: 'UK' }).inventory).toBeCloseTo(30)
    expect(findRow(rows, { country: 'DE' }).inventory).toBeCloseTo(100)

    // Total = 50+80+30+100 = 260
    expect(findRow(rows, { country: null }).inventory).toBeCloseTo(260)
  })

  // ── Flow-only: single-pass path still correct ────────────────────

  it('flow-only: uses single-pass, totals are plain SUMs', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue'],
    })

    // Flow-only → single pass (no subquery)
    expect(result.sql).not.toContain('_inner')

    const rows = await queryAll(conn, result.sql)

    expect(findRow(rows, { region: 'APAC', country: 'AU' }).revenue).toBeCloseTo(600)
    expect(findRow(rows, { region: 'APAC', country: 'JP' }).revenue).toBeCloseTo(1500)
    expect(findRow(rows, { region: 'APAC', country: null }).revenue).toBeCloseTo(2100)
    expect(findRow(rows, { region: 'EMEA', country: null }).revenue).toBeCloseTo(210)
    expect(findRow(rows, { region: null, country: null }).revenue).toBeCloseTo(2310)
  })

  // ── Day-weighted stock average ───────────────────────────────────

  it('stock weighted_avg with day weighting: weights by days in month', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['inventory'],
    })

    const rows = await queryAll(conn, result.sql)

    // Jan=31 days, Feb=28 days, Mar=31 days (2025 is not a leap year)
    // AU: (50*31 + 60*28 + 40*31) / (31+28+31) = (1550+1680+1240)/90 = 4470/90 = 49.667
    // JP: (80*31 + 70*28 + 90*31) / 90 = (2480+1960+2790)/90 = 7230/90 = 80.333
    // UK: all 30, so 30 regardless of weighting
    // DE: all 100, so 100 regardless of weighting
    expect(findRow(rows, { country: 'AU' }).inventory).toBeCloseTo(4470 / 90, 2)
    expect(findRow(rows, { country: 'JP' }).inventory).toBeCloseTo(7230 / 90, 2)
    expect(findRow(rows, { country: 'UK' }).inventory).toBeCloseTo(30)
    expect(findRow(rows, { country: 'DE' }).inventory).toBeCloseTo(100)

    // Total = SUM of day-weighted averages
    const expectedTotal = 4470 / 90 + 7230 / 90 + 30 + 100
    expect(findRow(rows, { country: null }).inventory).toBeCloseTo(expectedTotal, 2)
  })

  // ── VARCHAR date column with parseExpression ────────────────────

  it('stock weighted_avg with VARCHAR date column: parseExpression converts to DATE', async () => {
    // Create a table with VARCHAR month column (YYYY-MM format)
    await exec(conn, `
      CREATE TABLE varchar_dates (
        country VARCHAR, month_str VARCHAR, inventory DOUBLE
      );
      INSERT INTO varchar_dates VALUES
        ('AU', '2025-01', 50), ('AU', '2025-02', 60), ('AU', '2025-03', 40),
        ('JP', '2025-01', 80), ('JP', '2025-02', 70), ('JP', '2025-03', 90);
    `)

    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month_str', sourceField: 'month_str' },
      ],
      measures: [
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [{
        sourceColumn: 'month_str',
        granularity: 'month',
        stockWeighting: 'days',
        parseExpression: `CAST("month_str" || '-01' AS DATE)`,
      }],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['inventory'],
      source: 'varchar_dates',
    })

    const rows = await queryAll(conn, result.sql)

    // Same expected values as the DATE column test
    expect(findRow(rows, { country: 'AU' }).inventory).toBeCloseTo(4470 / 90, 2)
    expect(findRow(rows, { country: 'JP' }).inventory).toBeCloseTo(7230 / 90, 2)

    const expectedTotal = 4470 / 90 + 7230 / 90
    expect(findRow(rows, { country: null }).inventory).toBeCloseTo(expectedTotal, 2)

    await exec(conn, `DROP TABLE varchar_dates`)
  })

  it('stock eop with VARCHAR date column: parseExpression ensures correct ordering', async () => {
    await exec(conn, `
      CREATE TABLE varchar_eop (
        country VARCHAR, month_str VARCHAR, balance DOUBLE
      );
      INSERT INTO varchar_eop VALUES
        ('AU', '2025-01', 1000), ('AU', '2025-02', 1100), ('AU', '2025-03', 1200),
        ('JP', '2025-01', 2000), ('JP', '2025-02', 2200), ('JP', '2025-03', 2400);
    `)

    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month_str', sourceField: 'month_str' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [{
        sourceColumn: 'month_str',
        granularity: 'month',
        stockWeighting: 'months',
        parseExpression: `CAST("month_str" || '-01' AS DATE)`,
      }],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['balance'],
      source: 'varchar_eop',
    })

    const rows = await queryAll(conn, result.sql)

    // EOP = last period (March 2025)
    expect(findRow(rows, { country: 'AU' }).balance).toBeCloseTo(1200)
    expect(findRow(rows, { country: 'JP' }).balance).toBeCloseTo(2400)
    expect(findRow(rows, { country: null }).balance).toBeCloseTo(3600)

    await exec(conn, `DROP TABLE varchar_eop`)
  })

  // ── Same sourceField, different timeAggregation ──────────────────

  it('same source field with weighted_avg and eop produces correct distinct values', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'inv_avg', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
        { id: 'inv_eop', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['inv_avg', 'inv_eop'],
    })

    const rows = await queryAll(conn, result.sql)

    // AU: avg=50, eop(March)=40
    const au = findRow(rows, { country: 'AU' })
    expect(au.inv_avg).toBeCloseTo(50)
    expect(au.inv_eop).toBeCloseTo(40)

    // JP: avg=80, eop(March)=90
    const jp = findRow(rows, { country: 'JP' })
    expect(jp.inv_avg).toBeCloseTo(80)
    expect(jp.inv_eop).toBeCloseTo(90)

    // Totals: SUM of each
    const total = findRow(rows, { country: null })
    expect(total.inv_avg).toBeCloseTo(260)    // 50+80+30+100
    expect(total.inv_eop).toBeCloseTo(260)    // 40+90+30+100
  })

  // ── Time dimension on columns: total column uses weighted_avg ────

  it('stock measure with time-derived dim on columns: total column is weighted avg, not sum', async () => {
    // Derived "quarter" dimension from month. On columns, each quarter is a column.
    // The "Total" column should be the all-time weighted avg, not the sum of quarterly avgs.
    const schema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: `QUARTER("month")`, derivedFromField: 'month' },
      ],
      measures: [
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      columnDimensions: ['quarter'],
      measures: ['inventory'],
    })

    const rows = await queryAll(conn, result.sql)

    // All test data is Jan-Mar = Q1. So Q1 column = time-averaged value.
    // AU Q1: (50+60+40)/3 = 50
    // JP Q1: (80+70+90)/3 = 80
    const auQ1 = findRow(rows, { country: 'AU', quarter: 1 })
    expect(auQ1.inventory).toBeCloseTo(50)
    const jpQ1 = findRow(rows, { country: 'JP', quarter: 1 })
    expect(jpQ1.inventory).toBeCloseTo(80)

    // Total column (quarter=null): all-time avg, NOT sum of quarterly avgs.
    // Since all data is in Q1, the total equals Q1 value.
    const auTotal = findRow(rows, { country: 'AU', quarter: null })
    expect(auTotal.inventory).toBeCloseTo(50)  // avg, not sum

    // Country rollup in Q1: SUM of entity avgs
    const totalQ1 = findRow(rows, { country: null, quarter: 1 })
    expect(totalQ1.inventory).toBeCloseTo(260)  // 50+80+30+100

    // Grand total: SUM of entity all-time avgs
    const grandTotal = findRow(rows, { country: null, quarter: null })
    expect(grandTotal.inventory).toBeCloseTo(260)  // same since all data is Q1
  })

  it('mixed flow + stock with time on columns: flow sums across time, stock averages', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: `QUARTER("month")`, derivedFromField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      columnDimensions: ['quarter'],
      measures: ['revenue', 'inventory'],
    })

    const rows = await queryAll(conn, result.sql)

    // AU in Q1: revenue=600 (sum), inventory=50 (avg)
    const auQ1 = findRow(rows, { region: 'APAC', country: 'AU', quarter: 1 })
    expect(auQ1.revenue).toBeCloseTo(600)
    expect(auQ1.inventory).toBeCloseTo(50)

    // AU Total column: revenue=600 (sum, same since all Q1), inventory=50 (avg)
    const auTotal = findRow(rows, { region: 'APAC', country: 'AU', quarter: null })
    expect(auTotal.revenue).toBeCloseTo(600)
    expect(auTotal.inventory).toBeCloseTo(50)  // avg, NOT 50+50=100

    // APAC Q1: revenue=2100, inventory=130 (SUM of country avgs)
    const apacQ1 = findRow(rows, { region: 'APAC', country: null, quarter: 1 })
    expect(apacQ1.revenue).toBeCloseTo(2100)
    expect(apacQ1.inventory).toBeCloseTo(130)

    // APAC Total: revenue=2100, inventory=130
    const apacTotal = findRow(rows, { region: 'APAC', country: null, quarter: null })
    expect(apacTotal.revenue).toBeCloseTo(2100)
    expect(apacTotal.inventory).toBeCloseTo(130)
  })
})

// ── Unequal coverage: entities with different numbers of time periods ──
//
// This dataset exposes bugs where SUM-of-averages produces wrong results.
// Entity A has 3 months, entity B has 2 months, each with a category dim.
//
//   entity | category | month      | value
//   A      | X        | 2025-01-01 | 100
//   A      | X        | 2025-02-01 | 200
//   A      | X        | 2025-03-01 | 150
//   A      | Y        | 2025-01-01 | 50
//   A      | Y        | 2025-02-01 | 80
//   A      | Y        | 2025-03-01 | 60
//   B      | X        | 2025-01-01 | 300
//   B      | X        | 2025-02-01 | 400
//   B      | Y        | 2025-01-01 | 500
//   B      | Y        | 2025-02-01 | 600
//
// Day weights: Jan=31, Feb=28, Mar=31
//
// Reference values (day-weighted averages per entity per category):
//
//   A-X: (100*31 + 200*28 + 150*31) / (31+28+31) = (3100+5600+4650)/90 = 13350/90 = 148.3333...
//   A-Y: (50*31 + 80*28 + 60*31) / 90 = (1550+2240+1860)/90 = 5650/90 = 62.7778...
//   B-X: (300*31 + 400*28) / (31+28) = (9300+11200)/59 = 20500/59 = 347.4576...
//   B-Y: (500*31 + 600*28) / 59 = (15500+16800)/59 = 32300/59 = 547.4576...
//
// Per-month reference values (day-weighted avg across entities within a month):
//   Jan: A has (100+50)=150 over entities, B has (300+500)=800 → entities are separate
//   Per entity, per month: it's just the raw value (one row per entity×category×month)
//
// Grand total reference (day-weighted across ALL rows):
//   Numerator: 100*31+200*28+150*31+50*31+80*28+60*31+300*31+400*28+500*31+600*28
//            = 3100+5600+4650+1550+2240+1860+9300+11200+15500+16800 = 71800
//   Denominator: (31+28+31)*4 + (31+28)*2 = 90*4+59*2 = 360+118 = ... no wait,
//     each row has its own weight. A has 3 months × 2 categories = 6 rows,
//     B has 2 months × 2 categories = 4 rows.
//     But the weight is per-month, not per-row.
//
// For clarity: reference computations done via simple SQL below.

describe('Unequal coverage: reference query verification', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE uneq (
        entity VARCHAR,
        category VARCHAR,
        month DATE,
        value DOUBLE
      );
      INSERT INTO uneq VALUES
        ('A', 'X', DATE '2025-01-01', 100),
        ('A', 'X', DATE '2025-02-01', 200),
        ('A', 'X', DATE '2025-03-01', 150),
        ('A', 'Y', DATE '2025-01-01', 50),
        ('A', 'Y', DATE '2025-02-01', 80),
        ('A', 'Y', DATE '2025-03-01', 60),
        ('B', 'X', DATE '2025-01-01', 300),
        ('B', 'X', DATE '2025-02-01', 400),
        ('B', 'Y', DATE '2025-01-01', 500),
        ('B', 'Y', DATE '2025-02-01', 600);
    `)
  })

  afterAll(() => { db?.close() })

  // Day weight helper: Jan=31, Feb=28, Mar=31
  const JAN = 31, FEB = 28, MAR = 31

  // ── Layer 1: verify individual period values are just the raw values ──

  it('per entity×category×month values are the raw data', async () => {
    const rows = await queryAll(conn, `
      SELECT entity, category, month, value
      FROM uneq
      ORDER BY entity, category, month
    `)
    expect(rows).toHaveLength(10)
    expect(rows[0].value).toBe(100)  // A-X-Jan
    expect(rows[3].value).toBe(50)   // A-Y-Jan
    expect(rows[6].value).toBe(300)  // B-X-Jan
    expect(rows[9].value).toBe(600)  // B-Y-Feb
  })

  // ── Layer 2: verify day-weighted averages per entity×category via simple SQL ──

  it('reference: day-weighted avg per entity×category matches hand calculation', async () => {
    const rows = await queryAll(conn, `
      SELECT entity, category,
        SUM(value * DATE_DIFF('day', month, month + INTERVAL 1 MONTH))
          / SUM(DATE_DIFF('day', month, month + INTERVAL 1 MONTH)) AS wavg
      FROM uneq
      GROUP BY entity, category
      ORDER BY entity, category
    `)

    // A-X: (100*31 + 200*28 + 150*31) / 90 = 13350/90
    expect(rows[0].entity).toBe('A')
    expect(rows[0].category).toBe('X')
    expect(rows[0].wavg).toBeCloseTo(13350 / 90, 4)

    // A-Y: (50*31 + 80*28 + 60*31) / 90 = 5650/90
    expect(rows[1].entity).toBe('A')
    expect(rows[1].category).toBe('Y')
    expect(rows[1].wavg).toBeCloseTo(5650 / 90, 4)

    // B-X: (300*31 + 400*28) / 59 = 20500/59
    expect(rows[2].entity).toBe('B')
    expect(rows[2].category).toBe('X')
    expect(rows[2].wavg).toBeCloseTo(20500 / 59, 4)

    // B-Y: (500*31 + 600*28) / 59 = 32300/59
    expect(rows[3].entity).toBe('B')
    expect(rows[3].category).toBe('Y')
    expect(rows[3].wavg).toBeCloseTo(32300 / 59, 4)
  })

  // ── Layer 3: verify entity-level totals (sum of category avgs) ──

  it('reference: entity total = SUM of category day-weighted avgs', async () => {
    // Entity total = sum of per-category weighted averages (additive stock measure)
    const rows = await queryAll(conn, `
      WITH per_cat AS (
        SELECT entity, category,
          SUM(value * DATE_DIFF('day', month, month + INTERVAL 1 MONTH))
            / SUM(DATE_DIFF('day', month, month + INTERVAL 1 MONTH)) AS wavg
        FROM uneq
        GROUP BY entity, category
      )
      SELECT entity, SUM(wavg) AS total
      FROM per_cat
      GROUP BY entity
      ORDER BY entity
    `)

    // A total: 13350/90 + 5650/90 = 19000/90 = 211.111...
    expect(rows[0].entity).toBe('A')
    expect(rows[0].total).toBeCloseTo(19000 / 90, 4)

    // B total: 20500/59 + 32300/59 = 52800/59 = 894.915...
    expect(rows[1].entity).toBe('B')
    expect(rows[1].total).toBeCloseTo(52800 / 59, 4)
  })

  // ── Layer 4: verify grand total = SUM of all entity×category avgs ──

  it('reference: grand total = SUM of all entity×category day-weighted avgs', async () => {
    const rows = await queryAll(conn, `
      WITH per_cat AS (
        SELECT entity, category,
          SUM(value * DATE_DIFF('day', month, month + INTERVAL 1 MONTH))
            / SUM(DATE_DIFF('day', month, month + INTERVAL 1 MONTH)) AS wavg
        FROM uneq
        GROUP BY entity, category
      )
      SELECT SUM(wavg) AS grand_total
      FROM per_cat
    `)

    // 13350/90 + 5650/90 + 20500/59 + 32300/59 = 19000/90 + 52800/59
    const expected = 19000 / 90 + 52800 / 59
    expect(rows[0].grand_total).toBeCloseTo(expected, 4)
  })

  // ── Layer 5: verify per-month reference values for time-on-columns case ──

  it('reference: per entity×category per month, day-weighted avg is just the value', async () => {
    // When month is on columns, each cell is (entity×category, month).
    // With only one row per cell, the "weighted avg" is just the raw value.
    const rows = await queryAll(conn, `
      SELECT entity, category, month, value
      FROM uneq
      WHERE entity = 'A' AND category = 'X'
      ORDER BY month
    `)
    expect(rows[0].value).toBe(100)  // Jan
    expect(rows[1].value).toBe(200)  // Feb
    expect(rows[2].value).toBe(150)  // Mar
  })

  // ── Layer 6: per-month totals across entities (for time-on-columns row rollup) ──

  it('reference: per-month entity rollup = SUM of entity values for that month', async () => {
    const rows = await queryAll(conn, `
      SELECT month, SUM(value) AS total
      FROM uneq
      GROUP BY month
      ORDER BY month
    `)
    // Jan: 100+50+300+500 = 950
    expect(rows[0].total).toBeCloseTo(950)
    // Feb: 200+80+400+600 = 1280
    expect(rows[1].total).toBeCloseTo(1280)
    // Mar: 150+60 = 210 (only entity A)
    expect(rows[2].total).toBeCloseTo(210)
  })
})

// ── ROLLUP tests against the unequal coverage dataset ────────────────

describe('Unequal coverage: ROLLUP correctness', () => {
  let db: any
  let conn: any

  // Pre-computed reference values
  const AX_WAVG = 13350 / 90    // 148.333...
  const AY_WAVG = 5650 / 90     // 62.778...
  const BX_WAVG = 20500 / 59    // 347.458...
  const BY_WAVG = 32300 / 59    // 547.458...
  const A_TOTAL = 19000 / 90    // 211.111... (AX + AY)
  const B_TOTAL = 52800 / 59    // 894.915... (BX + BY)
  const GRAND_TOTAL = A_TOTAL + B_TOTAL  // 1106.027...

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE uneq (
        entity VARCHAR,
        category VARCHAR,
        month DATE,
        value DOUBLE
      );
      INSERT INTO uneq VALUES
        ('A', 'X', DATE '2025-01-01', 100),
        ('A', 'X', DATE '2025-02-01', 200),
        ('A', 'X', DATE '2025-03-01', 150),
        ('A', 'Y', DATE '2025-01-01', 50),
        ('A', 'Y', DATE '2025-02-01', 80),
        ('A', 'Y', DATE '2025-03-01', 60),
        ('B', 'X', DATE '2025-01-01', 300),
        ('B', 'X', DATE '2025-02-01', 400),
        ('B', 'Y', DATE '2025-01-01', 500),
        ('B', 'Y', DATE '2025-02-01', 600);
    `)
  })

  afterAll(() => { db?.close() })

  function uneqSchema(overrides?: {
    extraDims?: Partial<DimensionDefinition>[]
    measures?: Partial<MeasureDefinition>[]
  }): QuerySchema {
    return makeSchema({
      dimensions: [
        { id: 'entity', sourceField: 'entity' },
        { id: 'category', sourceField: 'category' },
        { id: 'month', sourceField: 'month' },
        ...(overrides?.extraDims ?? []),
      ],
      measures: overrides?.measures ?? [
        { id: 'value', sourceField: 'value', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })
  }

  // ── Row-only rollup: entity × category ──

  it('row rollup: entity×category weighted avgs match reference', async () => {
    const schema = uneqSchema()
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['entity', 'category'],
      measures: ['value'],
      source: 'uneq',
    })

    const rows = await queryAll(conn, result.sql)

    // Detail: entity×category weighted averages
    expect(findRow(rows, { entity: 'A', category: 'X' }).value).toBeCloseTo(AX_WAVG, 2)
    expect(findRow(rows, { entity: 'A', category: 'Y' }).value).toBeCloseTo(AY_WAVG, 2)
    expect(findRow(rows, { entity: 'B', category: 'X' }).value).toBeCloseTo(BX_WAVG, 2)
    expect(findRow(rows, { entity: 'B', category: 'Y' }).value).toBeCloseTo(BY_WAVG, 2)

    // Entity subtotals: SUM of category averages
    expect(findRow(rows, { entity: 'A', category: null }).value).toBeCloseTo(A_TOTAL, 2)
    expect(findRow(rows, { entity: 'B', category: null }).value).toBeCloseTo(B_TOTAL, 2)

    // Grand total: SUM of all entity×category averages
    expect(findRow(rows, { entity: null, category: null }).value).toBeCloseTo(GRAND_TOTAL, 2)
  })

  // ── Time on columns: month as column dimension ──

  it('time on columns: total column is all-time weighted avg, not sum of monthly values', async () => {
    const schema = uneqSchema()
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['entity', 'category'],
      columnDimensions: ['month'],
      measures: ['value'],
      source: 'uneq',
    })

    const rows = await queryAll(conn, result.sql)

    // Detail cells: entity×category × month = raw values (one row each)
    expect(findRow(rows, { entity: 'A', category: 'X', month: '2025-01-01' }).value).toBeCloseTo(100, 2)
    expect(findRow(rows, { entity: 'A', category: 'X', month: '2025-02-01' }).value).toBeCloseTo(200, 2)
    expect(findRow(rows, { entity: 'A', category: 'X', month: '2025-03-01' }).value).toBeCloseTo(150, 2)
    expect(findRow(rows, { entity: 'B', category: 'X', month: '2025-01-01' }).value).toBeCloseTo(300, 2)
    expect(findRow(rows, { entity: 'B', category: 'X', month: '2025-02-01' }).value).toBeCloseTo(400, 2)

    // Total column (month=null): all-time day-weighted average per entity×category
    expect(findRow(rows, { entity: 'A', category: 'X', month: null }).value).toBeCloseTo(AX_WAVG, 2)
    expect(findRow(rows, { entity: 'A', category: 'Y', month: null }).value).toBeCloseTo(AY_WAVG, 2)
    expect(findRow(rows, { entity: 'B', category: 'X', month: null }).value).toBeCloseTo(BX_WAVG, 2)
    expect(findRow(rows, { entity: 'B', category: 'Y', month: null }).value).toBeCloseTo(BY_WAVG, 2)

    // Entity subtotal, total column: SUM of category all-time avgs
    expect(findRow(rows, { entity: 'A', category: null, month: null }).value).toBeCloseTo(A_TOTAL, 2)
    expect(findRow(rows, { entity: 'B', category: null, month: null }).value).toBeCloseTo(B_TOTAL, 2)

    // Entity subtotal, per month: SUM of category values for that month
    // Jan: A-X(100) + A-Y(50) = 150
    expect(findRow(rows, { entity: 'A', category: null, month: '2025-01-01' }).value).toBeCloseTo(150, 2)
    // B only has Jan+Feb: B-X(300) + B-Y(500) = 800
    expect(findRow(rows, { entity: 'B', category: null, month: '2025-01-01' }).value).toBeCloseTo(800, 2)

    // Grand total, total column
    expect(findRow(rows, { entity: null, category: null, month: null }).value).toBeCloseTo(GRAND_TOTAL, 2)

    // Grand total per month: SUM of all entity×category values for that month
    // Jan: 100+50+300+500 = 950
    expect(findRow(rows, { entity: null, category: null, month: '2025-01-01' }).value).toBeCloseTo(950, 2)
    // Feb: 200+80+400+600 = 1280
    expect(findRow(rows, { entity: null, category: null, month: '2025-02-01' }).value).toBeCloseTo(1280, 2)
    // Mar: 150+60 = 210 (only entity A)
    expect(findRow(rows, { entity: null, category: null, month: '2025-03-01' }).value).toBeCloseTo(210, 2)
  })

  // ── Mixed time + non-time on columns ──

  it('mixed columns [category, month]: hierarchical ROLLUP subtotals', async () => {
    const schema = uneqSchema()
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['category', 'month'],
      measures: ['value'],
      source: 'uneq',
    })

    const rows = await queryAll(conn, result.sql)

    // Detail: entity × category × month
    expect(findRow(rows, { entity: 'A', category: 'X', month: '2025-01-01' }).value).toBeCloseTo(100, 2)
    expect(findRow(rows, { entity: 'B', category: 'Y', month: '2025-02-01' }).value).toBeCloseTo(600, 2)

    // No intermediate column subtotals — GROUPING SETS((category, month), ())
    // only produces leaf-level (both specific) and fully-rolled-up (both null).
    // Category-only subtotals (month=null, category=specific) no longer exist.

    // Row total: entity × category=null × month=null (all cols rolled up)
    expect(findRow(rows, { entity: 'A', category: null, month: null }).value).toBeCloseTo(A_TOTAL, 2)

    // Entity rollup: entity=null × category × month (detail col level)
    expect(findRow(rows, { entity: null, category: 'X', month: '2025-01-01' }).value).toBeCloseTo(400, 2)

    // Grand total
    expect(findRow(rows, { entity: null, category: null, month: null }).value).toBeCloseTo(GRAND_TOTAL, 2)
  })

  // ── Column order independence ──

  it('column order determines hierarchy: [category, month] vs [month, category]', async () => {
    const schema = uneqSchema()
    const qb = new QueryBuilder(schema)

    // Order 1: [category, month] → subtotals at category level (month rolled up)
    const r1 = qb.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['category', 'month'],
      measures: ['value'],
      source: 'uneq',
    })
    const rows1 = await queryAll(conn, r1.sql)

    // Order 2: [month, category] → subtotals at month level (category rolled up)
    const r2 = qb.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['month', 'category'],
      measures: ['value'],
      source: 'uneq',
    })
    const rows2 = await queryAll(conn, r2.sql)

    // Detail cells are the same in both orderings
    expect(findRow(rows1, { entity: 'A', category: 'X', month: '2025-01-01' }).value).toBeCloseTo(100, 2)
    expect(findRow(rows2, { entity: 'A', month: '2025-01-01', category: 'X' }).value).toBeCloseTo(100, 2)

    // No intermediate column subtotals in either ordering — GROUPING SETS
    // only produces leaf-level and fully-rolled-up column groups.

    // Both orderings produce the same grand total and row totals
    expect(findRow(rows1, { entity: 'A', category: null, month: null }).value).toBeCloseTo(A_TOTAL, 2)
    expect(findRow(rows2, { entity: 'A', month: null, category: null }).value).toBeCloseTo(A_TOTAL, 2)
    expect(findRow(rows1, { entity: null, category: null, month: null }).value).toBeCloseTo(GRAND_TOTAL, 2)
    expect(findRow(rows2, { entity: null, month: null, category: null }).value).toBeCloseTo(GRAND_TOTAL, 2)
  })
})

// ── parseRollupResult tests ────────────────────────────────────────────
//
// The parser in outline-table.ts converts raw SQL ROLLUP results into a
// TotalsResult structure (row/col/cross subtotals). It breaks on the first
// grouping=1, assuming ROLLUP guarantees contiguous patterns. This fails
// when time-derived column dims use GROUPING SETS (non-contiguous patterns).
//
// We test the parser logic directly with mock data to isolate the bug.

/**
 * Standalone parser mirroring outline-table.ts parseRollupResult.
 *
 * Duplicated from OutlineTable.parseRollupResult (src/components/outline-table.ts).
 * Not imported because the production version is a private method with additional
 * logic (true totals, dimValueToString) that isn't needed for this bug-isolation test.
 */
function parseRollupResult(
  columns: string[],
  rows: any[][],
  rollup: { groupingColumns: string[], dimensionFields: string[], rowDimensionCount: number, measureFields: string[] }
): {
  rowSubtotals: Map<string, Record<string, number>>,
  colSubtotals: Map<string, Record<string, number>>,
  crossSubtotals: Map<string, Record<string, number>>,
  grandTotal: Record<string, number>,
} {
  const { groupingColumns, dimensionFields, rowDimensionCount, measureFields } = rollup

  const colIndex = new Map<string, number>()
  for (let i = 0; i < columns.length; i++) {
    colIndex.set(columns[i], i)
  }

  const rowSubtotals = new Map<string, Record<string, number>>()
  const colSubtotals = new Map<string, Record<string, number>>()
  const crossSubtotals = new Map<string, Record<string, number>>()
  let grandTotal: Record<string, number> = {}

  for (const row of rows) {
    const groupings = groupingColumns.map(gc => {
      const idx = colIndex.get(gc)!
      return Number(row[idx])
    })

    // Build row path: consecutive row dims where grouping = 0
    const rowPath: string[] = []
    for (let i = 0; i < rowDimensionCount; i++) {
      if (groupings[i] === 0) {
        const dimIdx = colIndex.get(dimensionFields[i])!
        rowPath.push(String(row[dimIdx]))
      } else {
        break
      }
    }

    // Build col path: consecutive col dims where grouping = 0
    const colPath: string[] = []
    for (let i = rowDimensionCount; i < dimensionFields.length; i++) {
      if (groupings[i] === 0) {
        const dimIdx = colIndex.get(dimensionFields[i])!
        colPath.push(String(row[dimIdx]))
      } else {
        break  // BUG: assumes contiguous grouping pattern
      }
    }

    const metrics: Record<string, number> = {}
    for (const mf of measureFields) {
      const idx = colIndex.get(mf)!
      metrics[mf] = (row[idx] as number) ?? 0
    }

    const rowKey = rowPath.join(SEP)
    const colKey = colPath.join(SEP)
    crossSubtotals.set(`${rowKey}${CROSS_SEP}${colKey}`, metrics)
    if (colPath.length === 0) rowSubtotals.set(rowKey, metrics)
    if (rowPath.length === 0) colSubtotals.set(colKey, metrics)
    if (rowPath.length === 0 && colPath.length === 0) grandTotal = metrics
  }

  return { rowSubtotals, colSubtotals, crossSubtotals, grandTotal }
}

describe('parseRollupResult: non-contiguous grouping patterns', () => {
  let db: any
  let conn: any

  const AX_WAVG = 13350 / 90
  const AY_WAVG = 5650 / 90
  const BX_WAVG = 20500 / 59
  const BY_WAVG = 32300 / 59
  const A_TOTAL = 19000 / 90
  const B_TOTAL = 52800 / 59
  const GRAND_TOTAL = A_TOTAL + B_TOTAL

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE uneq (
        entity VARCHAR,
        category VARCHAR,
        month DATE,
        value DOUBLE
      );
      INSERT INTO uneq VALUES
        ('A', 'X', DATE '2025-01-01', 100),
        ('A', 'X', DATE '2025-02-01', 200),
        ('A', 'X', DATE '2025-03-01', 150),
        ('A', 'Y', DATE '2025-01-01', 50),
        ('A', 'Y', DATE '2025-02-01', 80),
        ('A', 'Y', DATE '2025-03-01', 60),
        ('B', 'X', DATE '2025-01-01', 300),
        ('B', 'X', DATE '2025-02-01', 400),
        ('B', 'Y', DATE '2025-01-01', 500),
        ('B', 'Y', DATE '2025-02-01', 600);
    `)
  })

  afterAll(() => { db?.close() })

  /**
   * Run a ROLLUP query and parse the results, returning both raw rows and parsed TotalsResult.
   * Converts DuckDB result format (array of objects) to the array-of-arrays format
   * that parseRollupResult expects (matching outline-table.ts QueryResult).
   */
  async function runAndParse(rollup: ReturnType<QueryBuilder['buildRollupAggregation']>) {
    const rawRows = await queryAll(conn, rollup.sql)
    if (rawRows.length === 0) return { rawRows, parsed: null }

    // Convert to QueryResult format: { columns: string[], rows: any[][] }
    const columns = Object.keys(rawRows[0])
    const arrayRows = rawRows.map(row => columns.map(c => {
      const v = row[c]
      // Normalize dates to strings (matching dimValueToString behavior)
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      return v
    }))

    const parsed = parseRollupResult(columns, arrayRows, rollup)
    return { rawRows, parsed }
  }

  it('columns [category, month]: contiguous patterns, parser handles correctly', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'entity', sourceField: 'entity' },
        { id: 'category', sourceField: 'category' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'value', sourceField: 'value', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['category', 'month'],
      measures: ['value'],
      source: 'uneq',
    })
    const { parsed } = await runAndParse(rollup)

    // With GROUPING SETS((category, month), ()), only two column patterns
    // exist: [0,0] (leaf) and [1,1] (fully rolled up). No intermediate
    // column subtotals like [0,1].

    // Row subtotal for entity A: all cols rolled up
    expect(parsed!.rowSubtotals.get('A')?.value).toBeCloseTo(A_TOTAL, 2)
    expect(parsed!.rowSubtotals.get('B')?.value).toBeCloseTo(B_TOTAL, 2)

    // Detail cross: entity × category × month
    expect(parsed!.crossSubtotals.get(`A${CROSS_SEP}X${SEP}2025-01-01`)?.value).toBeCloseTo(100, 2)
    expect(parsed!.crossSubtotals.get(`B${CROSS_SEP}Y${SEP}2025-02-01`)?.value).toBeCloseTo(600, 2)

    // No intermediate column subtotals (category-only, month rolled up)
    expect(parsed!.crossSubtotals.has(`A${CROSS_SEP}X`)).toBe(false)

    // Grand total
    expect(parsed!.grandTotal.value).toBeCloseTo(GRAND_TOTAL, 2)
  })

  it('columns [month, category]: contiguous patterns, parser handles correctly', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'entity', sourceField: 'entity' },
        { id: 'month', sourceField: 'month' },
        { id: 'category', sourceField: 'category' },
      ],
      measures: [
        { id: 'value', sourceField: 'value', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['month', 'category'],
      measures: ['value'],
      source: 'uneq',
    })
    const { parsed } = await runAndParse(rollup)

    // With GROUPING SETS((month, category), ()): only [0,0] and [1,1].
    // No intermediate column subtotals like per-month (category rolled up).

    expect(parsed!.rowSubtotals.get('A')?.value).toBeCloseTo(A_TOTAL, 2)

    // No intermediate column subtotal (month-only, category rolled up)
    expect(parsed!.crossSubtotals.has(`A${CROSS_SEP}2025-01-01`)).toBe(false)

    // Grand total
    expect(parsed!.grandTotal.value).toBeCloseTo(GRAND_TOTAL, 2)
  })

  it('both column orders: parser produces correct cross subtotal counts', async () => {
    const schema1 = makeSchema({
      dimensions: [
        { id: 'entity', sourceField: 'entity' },
        { id: 'category', sourceField: 'category' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'value', sourceField: 'value', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const schema2 = makeSchema({
      dimensions: [
        { id: 'entity', sourceField: 'entity' },
        { id: 'month', sourceField: 'month' },
        { id: 'category', sourceField: 'category' },
      ],
      measures: [
        { id: 'value', sourceField: 'value', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const qb1 = new QueryBuilder(schema1)
    const r1 = qb1.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['category', 'month'],
      measures: ['value'],
      source: 'uneq',
    })

    const qb2 = new QueryBuilder(schema2)
    const r2 = qb2.buildRollupAggregation({
      rowDimensions: ['entity'],
      columnDimensions: ['month', 'category'],
      measures: ['value'],
      source: 'uneq',
    })

    const { parsed: p1 } = await runAndParse(r1)
    const { parsed: p2 } = await runAndParse(r2)

    // Both orderings have the same grand total and row subtotals
    expect(p1!.grandTotal.value).toBeCloseTo(GRAND_TOTAL, 2)
    expect(p2!.grandTotal.value).toBeCloseTo(GRAND_TOTAL, 2)
    expect(p1!.rowSubtotals.get('A')?.value).toBeCloseTo(A_TOTAL, 2)
    expect(p2!.rowSubtotals.get('A')?.value).toBeCloseTo(A_TOTAL, 2)

    // Detail cells exist in both (different key format due to dim order)
    expect(p1!.crossSubtotals.get(`A${CROSS_SEP}X${SEP}2025-01-01`)?.value).toBeCloseTo(100, 2)
    expect(p2!.crossSubtotals.get(`A${CROSS_SEP}2025-01-01${SEP}X`)?.value).toBeCloseTo(100, 2)

    // Different orderings produce different hierarchical subtotals, so counts
    // may differ. But both should have reasonable counts (not collapsed by parser bugs).
    // With 2 entities × 2 categories × 3 months, plus ROLLUP subtotals, both should
    // have at least 18 cross entries (spurious NULL groups from CTE UNION ALL are
    // filtered out by HAVING, so count is slightly lower than the raw ROLLUP would give).
    expect(p1!.crossSubtotals.size).toBeGreaterThan(18)
    expect(p2!.crossSubtotals.size).toBeGreaterThan(18)
  })
})

// ═════════════════════════════════════════════════════════════════════
// Result limiting: probe mode and flat mode
// ═════════════════════════════════════════════════════════════════════

describe('Result limiting', () => {
  let db: any
  let conn: any

  // 3 regions × 4 countries × 1 metric
  // APAC: AU=100, JP=200, SG=50
  // EMEA: UK=300, DE=150, FR=80
  // AMER: US=500, CA=120, MX=60, BR=90
  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        country VARCHAR,
        product VARCHAR,
        revenue DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', 'A', 40), ('APAC', 'AU', 'B', 60),
        ('APAC', 'JP', 'A', 80), ('APAC', 'JP', 'B', 120),
        ('APAC', 'SG', 'A', 20), ('APAC', 'SG', 'B', 30),
        ('EMEA', 'UK', 'A', 100), ('EMEA', 'UK', 'B', 200),
        ('EMEA', 'DE', 'A', 60), ('EMEA', 'DE', 'B', 90),
        ('EMEA', 'FR', 'A', 30), ('EMEA', 'FR', 'B', 50),
        ('AMER', 'US', 'A', 200), ('AMER', 'US', 'B', 300),
        ('AMER', 'CA', 'A', 50), ('AMER', 'CA', 'B', 70),
        ('AMER', 'MX', 'A', 25), ('AMER', 'MX', 'B', 35),
        ('AMER', 'BR', 'A', 35), ('AMER', 'BR', 'B', 55);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
      { id: 'product', sourceField: 'product' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
    ]
  })

  it('buildProbeQuery: detects overflow when count exceeds probeLimit', async () => {
    const qb = new QueryBuilder(schema)
    // 10 countries × 2 products = 20 leaf combos. Probe with limit 5.
    const sql = qb.buildProbeQuery({
      dimensions: ['country', 'product'],
      probeLimit: 5
    })

    expect(sql).toContain('_check')
    expect(sql).toContain('LIMIT 6')  // probeLimit + 1
    expect(sql).toContain('COUNT(*)')

    const rows = await queryAll(conn, sql)
    // COUNT should be 6 (probeLimit + 1, capped by the subquery LIMIT)
    expect(Number(rows[0].n)).toBe(6)
  })

  it('buildProbeQuery: returns exact count when under limit', async () => {
    const qb = new QueryBuilder(schema)
    // probeLimit = 100 is larger than the 20 leaf combos
    const sql = qb.buildProbeQuery({
      dimensions: ['country', 'product'],
      probeLimit: 100
    })

    const rows = await queryAll(conn, sql)
    // Should return exact count: 10 countries × 2 products = 20
    expect(Number(rows[0].n)).toBe(20)
  })

  it('buildProbeQuery: respects filters', async () => {
    const qb = new QueryBuilder(schema)
    const sql = qb.buildProbeQuery({
      dimensions: ['country', 'product'],
      filters: [{ field: 'region', operator: '=', value: 'APAC' }],
      probeLimit: 100
    })

    const rows = await queryAll(conn, sql)
    // APAC has 3 countries × 2 products = 6 combos
    expect(Number(rows[0].n)).toBe(6)
  })

  it('flat mode: limitRows restricts to top-N rows by first metric', async () => {
    const qb = new QueryBuilder(schema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue'],
      limitRows: 3
    })

    expect(r.sql).toContain('_top_rows')
    expect(r.sql).toContain('_filtered')
    expect(r.sql).toContain('ORDER BY SUM("revenue") DESC')
    expect(r.sql).toContain('LIMIT 3')

    const rows = await queryAll(conn, r.sql)
    const leafRows = rollupRows(rows).filter(row =>
      r.groupingColumns.every(gc => Number(row[gc]) === 0)
    )

    // Only top-3 countries by revenue: US(500), UK(300), JP(200)
    expect(leafRows.length).toBe(3)
    const countries = leafRows.map(row => row.country).sort()
    expect(countries).toEqual(['JP', 'UK', 'US'])
  })

  it('flat mode: limitCols restricts to top-N columns', async () => {
    const qb = new QueryBuilder(schema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['product'],
      measures: ['revenue'],
      limitCols: 1
    })

    expect(r.sql).toContain('_top_cols')
    expect(r.sql).toContain('_filtered')

    const rows = await queryAll(conn, r.sql)

    // Only top-1 product by revenue should be present in leaf rows
    const leafRows = rollupRows(rows).filter(row =>
      r.groupingColumns.every(gc => Number(row[gc]) === 0)
    )
    const products = new Set(leafRows.map(row => row.product))
    expect(products.size).toBe(1)
    expect(products.has('B')).toBe(true)  // B has higher revenue than A
  })

  it('flat mode: both limitRows and limitCols together', async () => {
    const qb = new QueryBuilder(schema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      columnDimensions: ['product'],
      measures: ['revenue'],
      limitRows: 2,
      limitCols: 1
    })

    expect(r.sql).toContain('_top_rows')
    expect(r.sql).toContain('_top_cols')
    expect(r.sql).toContain('_filtered')

    const rows = await queryAll(conn, r.sql)
    const leafRows = rollupRows(rows).filter(row =>
      r.groupingColumns.every(gc => Number(row[gc]) === 0)
    )

    // 2 countries × 1 product = 2 leaf rows
    expect(leafRows.length).toBe(2)

    // Top-2 countries: US(500), UK(300). Top-1 product: B
    const countries = new Set(leafRows.map(row => row.country))
    expect(countries.has('US')).toBe(true)
    expect(countries.has('UK')).toBe(true)
    const products = new Set(leafRows.map(row => row.product))
    expect(products.size).toBe(1)
    expect(products.has('B')).toBe(true)
  })

  it('flat mode: ROLLUP subtotals are correct for the bounded set', async () => {
    const qb = new QueryBuilder(schema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue'],
      limitRows: 2
    })

    const rows = await queryAll(conn, r.sql)

    // Grand total should be sum of top-2 countries only (US=500, UK=300)
    const grandTotal = findRow(rows, { country: null })
    expect(grandTotal.revenue).toBeCloseTo(800, 0)
  })

  it('no limiting: omitting all limit opts produces normal ROLLUP', async () => {
    const qb = new QueryBuilder(schema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
    })

    // Should NOT have any CTEs
    expect(r.sql).not.toContain('_probe')
    expect(r.sql).not.toContain('_top_rows')
    expect(r.sql).not.toContain('_filtered')

    const rows = await queryAll(conn, r.sql)
    const grandTotal = findRow(rows, { region: null })
    expect(grandTotal.revenue).toBeCloseTo(1650, 0)
  })

  // ── Hierarchical row dimensions + limitRows ────────────────────

  describe('limitRows with multiple hierarchical row dimensions', () => {
    it('limits (region, country) tuples and produces correct subtotals', async () => {
      const qb = new QueryBuilder(schema)
      // 10 distinct (region, country) combos exist. Limit to top 4.
      const r = qb.buildRollupAggregation({
        rowDimensions: ['region', 'country'],
        measures: ['revenue'],
        limitRows: 4
      })

      expect(r.sql).toContain('_top_rows')
      expect(r.sql).toContain('_filtered')

      const rows = await queryAll(conn, r.sql)

      // Leaf rows: only 4 (region, country) combos with both grouping cols = 0
      const leafRows = rollupRows(rows).filter(row =>
        r.groupingColumns.every(gc => Number(row[gc]) === 0)
      )
      expect(leafRows.length).toBe(4)

      // Top-4 by revenue: (AMER,US)=500, (EMEA,UK)=300, (APAC,JP)=200, (EMEA,DE)=150
      const tuples = leafRows.map(row => `${row.region}:${row.country}`).sort()
      expect(tuples).toEqual(['AMER:US', 'APAC:JP', 'EMEA:DE', 'EMEA:UK'])

      // Region subtotals (country rolled up): should reflect only included countries
      const amerSubtotal = findRow(rows, { region: 'AMER', country: null })
      expect(amerSubtotal.revenue).toBeCloseTo(500, 0)  // only US included

      const emeaSubtotal = findRow(rows, { region: 'EMEA', country: null })
      expect(emeaSubtotal.revenue).toBeCloseTo(450, 0)  // UK(300) + DE(150)

      const apacSubtotal = findRow(rows, { region: 'APAC', country: null })
      expect(apacSubtotal.revenue).toBeCloseTo(200, 0)  // only JP included

      // Grand total: sum of the limited set
      const grandTotal = findRow(rows, { region: null, country: null })
      expect(grandTotal.revenue).toBeCloseTo(1150, 0)  // 500+300+200+150
    })

    it('limitRows=2 with two row dims picks the top-2 tuples', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['region', 'country'],
        measures: ['revenue'],
        limitRows: 2
      })

      const rows = await queryAll(conn, r.sql)
      const leafRows = rollupRows(rows).filter(row =>
        r.groupingColumns.every(gc => Number(row[gc]) === 0)
      )
      expect(leafRows.length).toBe(2)

      // Top-2: (AMER,US)=500, (EMEA,UK)=300
      const tuples = leafRows.map(row => `${row.region}:${row.country}`).sort()
      expect(tuples).toEqual(['AMER:US', 'EMEA:UK'])

      // Grand total = 800
      const grandTotal = findRow(rows, { region: null, country: null })
      expect(grandTotal.revenue).toBeCloseTo(800, 0)
    })
  })

  // ── addTrueTotals ────────────────────────────────────────────────

  describe('addTrueTotals', () => {
    /** Extract true total rows by _tt value (1=grand, 2=row subtotals, 3=col subtotals). */
    function trueTotalRows(rows: Record<string, any>[], tt: number): Record<string, any>[] {
      return rows.filter(row => Number(row._tt) === tt)
    }

    it('true grand total matches full dataset', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        measures: ['revenue'],
        limitRows: 3,
      })

      const rows = await queryAll(conn, r.sql)

      // ROLLUP grand total = top-3 only (US=500 + UK=300 + JP=200 = 1000)
      const rollupGrand = findRow(rows, { country: null })
      expect(rollupGrand.revenue).toBeCloseTo(1000, 0)

      // True grand total (_tt=1) = sum across ALL rows = 1650
      const trueGrand = trueTotalRows(rows, 1)
      expect(trueGrand.length).toBe(1)
      expect(trueGrand[0].revenue).toBeCloseTo(1650, 0)
    })

    it('true row subtotals when limitCols active', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        columnDimensions: ['product'],
        measures: ['revenue'],
        limitCols: 1,
      })

      const rows = await queryAll(conn, r.sql)

      // Top-1 product = B (1010). Leaf ROLLUP rows only have product B values.
      // True row subtotals (_tt=2): each country's revenue across ALL products (A+B).
      const rowTotals = trueTotalRows(rows, 2)
      // Without limitRows, all 10 countries appear
      expect(rowTotals.length).toBe(10)

      // Spot-check a few countries: total = A + B
      const us = rowTotals.find(r => r.country === 'US')
      expect(us!.revenue).toBeCloseTo(500, 0)  // 200+300
      const au = rowTotals.find(r => r.country === 'AU')
      expect(au!.revenue).toBeCloseTo(100, 0)  // 40+60
    })

    it('true col subtotals when limitRows active', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        columnDimensions: ['product'],
        measures: ['revenue'],
        limitRows: 3,
      })

      const rows = await queryAll(conn, r.sql)

      // Top-3 countries: US, UK, JP. ROLLUP only has those countries.
      // True col subtotals (_tt=3): each product's revenue across ALL countries.
      const colTotals = trueTotalRows(rows, 3)
      expect(colTotals.length).toBe(2)  // both products

      const prodA = colTotals.find(r => r.product === 'A')
      expect(prodA!.revenue).toBeCloseTo(640, 0)
      const prodB = colTotals.find(r => r.product === 'B')
      expect(prodB!.revenue).toBeCloseTo(1010, 0)
    })

    it('both limits active: all three true total types present', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        columnDimensions: ['product'],
        measures: ['revenue'],
        limitRows: 2,
        limitCols: 1,
      })

      const rows = await queryAll(conn, r.sql)

      // True grand total (_tt=1) = 1650
      const trueGrand = trueTotalRows(rows, 1)
      expect(trueGrand.length).toBe(1)
      expect(trueGrand[0].revenue).toBeCloseTo(1650, 0)

      // True row subtotals (_tt=2): top-2 countries (US, UK) totalled across ALL products
      // (row filter to _top_rows is applied when limitRows is active)
      const rowTotals = trueTotalRows(rows, 2)
      expect(rowTotals.length).toBe(2)
      const usRow = rowTotals.find(r => r.country === 'US')
      expect(usRow!.revenue).toBeCloseTo(500, 0)
      const ukRow = rowTotals.find(r => r.country === 'UK')
      expect(ukRow!.revenue).toBeCloseTo(300, 0)

      // True col subtotals (_tt=3): top-1 product (B) totalled across ALL countries
      // (col filter to _top_cols is applied when limitCols is active)
      const colTotals = trueTotalRows(rows, 3)
      expect(colTotals.length).toBe(1)
      expect(colTotals[0].product).toBe('B')
      expect(colTotals[0].revenue).toBeCloseTo(1010, 0)
    })

    it('no true totals without limits', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        measures: ['revenue'],
      })

      const rows = await queryAll(conn, r.sql)

      // No _tt column at all, or all _tt=0
      const trueTotals = rows.filter(row => row._tt != null && Number(row._tt) > 0)
      expect(trueTotals.length).toBe(0)
    })

    it('true totals with filters respect filter but not top-N', async () => {
      const qb = new QueryBuilder(schema)
      const r = qb.buildRollupAggregation({
        rowDimensions: ['country'],
        measures: ['revenue'],
        limitRows: 2,
        filters: [{ field: 'region', operator: '=', value: 'APAC' }],
      })

      const rows = await queryAll(conn, r.sql)

      // APAC countries: JP=200, AU=100, SG=50. Top-2: JP, AU.
      const leafRows = rollupRows(rows).filter(row =>
        r.groupingColumns.every(gc => Number(row[gc]) === 0)
      )
      expect(leafRows.length).toBe(2)

      // ROLLUP grand total = top-2 only = 200+100 = 300
      const rollupGrand = findRow(rows, { country: null })
      expect(rollupGrand.revenue).toBeCloseTo(300, 0)

      // True grand total = all APAC = 200+100+50 = 350 (respects filter, not top-N)
      const trueGrand = trueTotalRows(rows, 1)
      expect(trueGrand.length).toBe(1)
      expect(trueGrand[0].revenue).toBeCloseTo(350, 0)
    })
  })
})

// ═════════════════════════════════════════════════════════════════════
// Two-pass rollup flat mode (stock measures with limiting)
// ═════════════════════════════════════════════════════════════════════

describe('Two-pass rollup flat mode', () => {
  // Uses the same 12-row dataset from the main test data block above.
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
        revenue DOUBLE,
        inventory DOUBLE,
        balance DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', '2025-01-01', 100, 50, 1000),
        ('APAC', 'AU', '2025-02-01', 200, 60, 1100),
        ('APAC', 'AU', '2025-03-01', 300, 40, 1200),
        ('APAC', 'JP', '2025-01-01', 400, 80, 2000),
        ('APAC', 'JP', '2025-02-01', 500, 70, 2200),
        ('APAC', 'JP', '2025-03-01', 600, 90, 2400),
        ('EMEA', 'UK', '2025-01-01', 10, 30, 500),
        ('EMEA', 'UK', '2025-02-01', 20, 30, 600),
        ('EMEA', 'UK', '2025-03-01', 30, 30, 700),
        ('EMEA', 'DE', '2025-01-01', 40, 100, 3000),
        ('EMEA', 'DE', '2025-02-01', 50, 100, 3200),
        ('EMEA', 'DE', '2025-03-01', 60, 100, 3500);
    `)
  })

  afterAll(() => { db?.close() })

  const stockSchema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
      { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
    ],
    timeDimensions: [
      { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
    ]
  })

  it('flat mode limitRows on two-pass rollup: SQL has _top_rows CTE', () => {
    const qb = new QueryBuilder(stockSchema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue', 'inventory', 'balance'],
      limitRows: 2
    })

    expect(r.sql).toContain('_top_rows')
    expect(r.sql).toContain('LIMIT 2')
    expect(r.sql).toContain('IN (SELECT')
  })

  it('flat mode limitRows restricts to top-N countries with correct stock values', async () => {
    const qb = new QueryBuilder(stockSchema)

    // Unlimited reference
    const ref = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue', 'inventory', 'balance'],
    })
    const refRows = await queryAll(conn, ref.sql)

    // Limited to top 2 by revenue (JP=1500, AU=600 — based on SUM proxy)
    const limited = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue', 'inventory', 'balance'],
      limitRows: 2
    })
    const limitedRows = await queryAll(conn, limited.sql)

    const leafRows = rollupRows(limitedRows).filter(row =>
      limited.groupingColumns.every(gc => Number(row[gc]) === 0)
    )
    expect(leafRows.length).toBe(2)

    const countries = new Set(leafRows.map(row => row.country))
    expect(countries.has('JP')).toBe(true)
    expect(countries.has('AU')).toBe(true)

    // Stock values should match reference values for included countries
    const refAU = findRow(refRows, { country: 'AU' })
    const limAU = findRow(limitedRows, { country: 'AU' })
    expect(limAU.inventory).toBeCloseTo(refAU.inventory, 2)  // weighted_avg: 50
    expect(limAU.balance).toBeCloseTo(refAU.balance, 2)      // eop: 1200

    const refJP = findRow(refRows, { country: 'JP' })
    const limJP = findRow(limitedRows, { country: 'JP' })
    expect(limJP.inventory).toBeCloseTo(refJP.inventory, 2)  // weighted_avg: 80
    expect(limJP.balance).toBeCloseTo(refJP.balance, 2)      // eop: 2400

    // Grand total should be sum of included countries only
    const grandTotal = findRow(limitedRows, { country: null })
    expect(grandTotal.revenue).toBeCloseTo(2100, 0)   // 1500 + 600
    expect(grandTotal.inventory).toBeCloseTo(130, 0)   // 80 + 50
    expect(grandTotal.balance).toBeCloseTo(3600, 0)    // 2400 + 1200
  })

  it('flat mode with region dimension: limitRows restricts regions', async () => {
    const qb = new QueryBuilder(stockSchema)
    const r = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue', 'inventory'],
      limitRows: 1
    })

    const rows = await queryAll(conn, r.sql)
    const leafRows = rollupRows(rows).filter(row =>
      r.groupingColumns.every(gc => Number(row[gc]) === 0)
    )
    expect(leafRows.length).toBe(1)

    // APAC has higher revenue (2100 vs 210), so it should be selected
    expect(leafRows[0].region).toBe('APAC')

    // Values should be correct for APAC
    expect(leafRows[0].revenue).toBeCloseTo(2100, 0)
    expect(leafRows[0].inventory).toBeCloseTo(130, 0)
  })

  it('true grand total uses correct stock aggregation (not flat avg)', async () => {
    // Bug: addTrueTotals applies SUM(field*weight)/SUM(weight) across ALL rows,
    // which gives a global average (65) instead of the sum of per-entity
    // time-averaged values (260). Stock measures need two-pass aggregation
    // even for true totals: avg across time per entity, then SUM across entities.
    //
    // Hand-computed expected values:
    //   weighted_avg per country: AU=50, JP=80, UK=30, DE=100
    //   Correct true grand total = SUM of all = 260
    //   Bug produces: SUM(all 12 values)/12 = 780/12 = 65
    //
    //   EOP per country: AU=1200, JP=2400, UK=700, DE=3500
    //   Correct true grand total = SUM of all = 7800
    //   Bug produces: MAX(all 12 values) = 3500

    const qb = new QueryBuilder(stockSchema)

    // Get unlimited reference for comparison
    const ref = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue', 'inventory', 'balance'],
    })
    const refRows = await queryAll(conn, ref.sql)
    const refGrand = findRow(refRows, { country: null })

    // Limited query triggers addTrueTotals
    const limited = qb.buildRollupAggregation({
      rowDimensions: ['country'],
      measures: ['revenue', 'inventory', 'balance'],
      limitRows: 2,
    })
    const limitedRows = await queryAll(conn, limited.sql)

    // True grand total (_tt=1) should match the unlimited grand total
    const trueGrand = limitedRows.filter(row => Number(row._tt) === 1)
    expect(trueGrand.length).toBe(1)

    // Flow measure (revenue): SUM is straightforward — should be correct
    expect(trueGrand[0].revenue).toBeCloseTo(refGrand.revenue, 0)  // 2310

    // Stock weighted_avg (inventory): should be 260 (sum of per-entity averages)
    expect(trueGrand[0].inventory).toBeCloseTo(refGrand.inventory, 0)  // 260

    // Stock EOP (balance): should be 7800 (sum of per-entity last values)
    expect(trueGrand[0].balance).toBeCloseTo(refGrand.balance, 0)  // 7800
  })
})

// ── Time dimension ON rows: totals use time aggregation ──────────────
//
// When a time-derived dim is a row dimension, the ROLLUP total must use
// the measure's timeAggregation (weighted_avg, eop) instead of plain SUM.
// This is the user-reported bug: "putting month on rows, total is wrong."

describe('Time dimension on rows: correct ROLLUP totals', () => {
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
        revenue DOUBLE,
        inventory DOUBLE,
        balance DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', DATE '2025-01-01', 100, 50, 1000),
        ('APAC', 'AU', DATE '2025-02-01', 200, 60, 1100),
        ('APAC', 'AU', DATE '2025-03-01', 300, 40, 1200),
        ('APAC', 'JP', DATE '2025-01-01', 400, 80, 2000),
        ('APAC', 'JP', DATE '2025-02-01', 500, 70, 2200),
        ('APAC', 'JP', DATE '2025-03-01', 600, 90, 2400),
        ('EMEA', 'UK', DATE '2025-01-01', 10,  30, 500),
        ('EMEA', 'UK', DATE '2025-02-01', 20,  30, 600),
        ('EMEA', 'UK', DATE '2025-03-01', 30,  30, 700),
        ('EMEA', 'DE', DATE '2025-01-01', 40,  100, 3000),
        ('EMEA', 'DE', DATE '2025-02-01', 50,  100, 3200),
        ('EMEA', 'DE', DATE '2025-03-01', 60,  100, 3500);
    `)
  })

  afterAll(() => { db?.close() })

  it('weighted_avg: month on rows, total = weighted avg of monthly sums (equal weights)', async () => {
    // Use balance which has different monthly totals (6500, 7100, 7800)
    // so the weighted avg (7133.33) is clearly distinct from the SUM (21400).
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per-month: SUM of all entities' balance
    // Jan: 1000+2000+500+3000 = 6500
    // Feb: 1100+2200+600+3200 = 7100
    // Mar: 1200+2400+700+3500 = 7800
    expect(findRow(rows, { month: '2025-01-01' }).balance).toBeCloseTo(6500)
    expect(findRow(rows, { month: '2025-02-01' }).balance).toBeCloseTo(7100)
    expect(findRow(rows, { month: '2025-03-01' }).balance).toBeCloseTo(7800)

    // Grand total: equal-weight avg = (6500+7100+7800)/3 ≈ 7133.33
    // NOT 21400 (which would be plain SUM)
    expect(findRow(rows, { month: null }).balance).toBeCloseTo((6500 + 7100 + 7800) / 3, 1)
  })

  it('weighted_avg: month on rows with day weighting', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per-month: SUM of all entities' balance
    // Jan: 1000+2000+500+3000 = 6500
    // Feb: 1100+2200+600+3200 = 7100
    // Mar: 1200+2400+700+3500 = 7800
    expect(findRow(rows, { month: '2025-01-01' }).balance).toBeCloseTo(6500)
    expect(findRow(rows, { month: '2025-02-01' }).balance).toBeCloseTo(7100)
    expect(findRow(rows, { month: '2025-03-01' }).balance).toBeCloseTo(7800)

    // Grand total: day-weighted average = SUM(monthly_sum * days) / SUM(days)
    // Jan=31d, Feb=28d, Mar=31d
    const expected = (6500 * 31 + 7100 * 28 + 7800 * 31) / (31 + 28 + 31)
    expect(findRow(rows, { month: null }).balance).toBeCloseTo(expected, 1)
  })

  it('eop: month on rows, total = latest month value', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per-month: SUM of all entities' balance
    expect(findRow(rows, { month: '2025-01-01' }).balance).toBeCloseTo(6500)
    expect(findRow(rows, { month: '2025-02-01' }).balance).toBeCloseTo(7100)
    expect(findRow(rows, { month: '2025-03-01' }).balance).toBeCloseTo(7800)

    // Grand total: EOP = latest month's value = March = 7800
    expect(findRow(rows, { month: null }).balance).toBeCloseTo(7800)
  })

  it('mixed flow + stock with month on rows', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month'],
      measures: ['revenue', 'inventory', 'balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per-month sums
    const jan = findRow(rows, { month: '2025-01-01' })
    expect(jan.revenue).toBeCloseTo(550)     // 100+400+10+40
    expect(jan.inventory).toBeCloseTo(260)   // 50+80+30+100
    expect(jan.balance).toBeCloseTo(6500)    // 1000+2000+500+3000

    // Grand total: each measure type uses its own aggregation
    const total = findRow(rows, { month: null })
    expect(total.revenue).toBeCloseTo(2310)   // flow: sum of all months
    expect(total.inventory).toBeCloseTo(260)  // weighted_avg: avg of monthly sums (all equal)
    expect(total.balance).toBeCloseTo(7800)   // eop: latest month's sum
  })

  it('weighted_avg: month on rows with limitRows (flat mode)', async () => {
    // Use balance (monthly totals: Jan=6500, Feb=7100, Mar=7800)
    // limitRows=2 picks top 2 by SUM DESC → Feb(7100) and Mar(7800)
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month'],
      measures: ['balance'],
      limitRows: 2,  // top 2 months by SUM(balance) DESC
    })

    const rows = await queryAll(conn, result.sql)

    const leafRows = rollupRows(rows).filter(row => Number(row._g_month) === 0)
    expect(leafRows.length).toBe(2)

    // Top 2 are Mar(7800) and Feb(7100)
    expect(findRow(rows, { month: '2025-03-01' }).balance).toBeCloseTo(7800)
    expect(findRow(rows, { month: '2025-02-01' }).balance).toBeCloseTo(7100)

    // Grand total: equal-weight avg of the 2 included months = (7100+7800)/2 = 7450
    // NOT 14900 (sum)
    expect(findRow(rows, { month: null }).balance).toBeCloseTo((7100 + 7800) / 2, 1)
  })
})

// ── Two-pass: time-derived dim on rows (e.g., quarter) ───────────────
//
// When a coarser time dim like quarter is on rows and the source column (month)
// is hidden, the two-pass rollup handles the inner time collapse. But the
// outer ROLLUP's grand total must use weighted_avg/eop, not plain SUM.
// This is the user-reported bug: "quarter on rows, total is wrong."

describe('Two-pass: time-derived row dim (quarter on rows)', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    // 2 entities × 6 months (Q1 + Q2) — different balance per month so
    // weighted avg is clearly different from SUM of quarterly values.
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        month DATE,
        revenue DOUBLE,
        balance DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', DATE '2025-01-01', 100, 1000),
        ('APAC', DATE '2025-02-01', 200, 1100),
        ('APAC', DATE '2025-03-01', 300, 1200),
        ('APAC', DATE '2025-04-01', 400, 1300),
        ('APAC', DATE '2025-05-01', 500, 1400),
        ('APAC', DATE '2025-06-01', 600, 1500),
        ('EMEA', DATE '2025-01-01', 10,  2000),
        ('EMEA', DATE '2025-02-01', 20,  2200),
        ('EMEA', DATE '2025-03-01', 30,  2400),
        ('EMEA', DATE '2025-04-01', 40,  2600),
        ('EMEA', DATE '2025-05-01', 50,  2800),
        ('EMEA', DATE '2025-06-01', 60,  3000);
    `)
  })

  afterAll(() => { db?.close() })

  // Quarter as derived dim: QUARTER("month") produces 1 or 2
  const baseSchema = (opts: { timeAgg: string; stockWeighting?: string; extraMeasures?: Partial<MeasureDefinition>[] }) =>
    makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: opts.timeAgg },
        ...(opts.extraMeasures ?? []),
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: opts.stockWeighting ?? 'months' },
      ],
    })

  it('weighted_avg: quarter on rows, grand total = weighted avg across all months', async () => {
    // quarter on rows → month hidden → two-pass rollup.
    // Per quarter (equal-weight avg of monthly totals):
    //   Q1: monthly totals = 3000, 3300, 3600 → avg = 3300
    //   Q2: monthly totals = 3900, 4200, 4500 → avg = 4200
    // Grand total: avg across all 6 months = (3000+3300+3600+3900+4200+4500)/6 = 3750
    // BUG would give: SUM(3300, 4200) = 7500
    const schema = baseSchema({ timeAgg: 'weighted_avg' })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    expect(findRow(rows, { quarter: 1 }).balance).toBeCloseTo(3300)
    expect(findRow(rows, { quarter: 2 }).balance).toBeCloseTo(4200)
    expect(findRow(rows, { quarter: null }).balance).toBeCloseTo(3750)
  })

  it('weighted_avg: quarter on rows with day weighting', async () => {
    const schema = baseSchema({ timeAgg: 'weighted_avg', stockWeighting: 'days' })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Day-weighted per quarter:
    //   Q1: (3000*31 + 3300*28 + 3600*31) / (31+28+31) = (93000+92400+111600)/90 = 3300
    //   Q2: (3900*30 + 4200*31 + 4500*30) / (30+31+30) = (117000+130200+135000)/91 ≈ 4200.00
    // Grand total: day-weighted across all 6 months
    const jan=31, feb=28, mar=31, apr=30, may=31, jun=30
    const totalDays = jan+feb+mar+apr+may+jun
    const expected = (3000*jan + 3300*feb + 3600*mar + 3900*apr + 4200*may + 4500*jun) / totalDays
    expect(findRow(rows, { quarter: null }).balance).toBeCloseTo(expected, 0)
  })

  it('eop: quarter on rows, grand total = latest month value', async () => {
    const schema = baseSchema({ timeAgg: 'eop' })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per quarter: EOP = last month's total
    //   Q1: March total = 1200+2400 = 3600
    //   Q2: June total = 1500+3000 = 4500
    expect(findRow(rows, { quarter: 1 }).balance).toBeCloseTo(3600)
    expect(findRow(rows, { quarter: 2 }).balance).toBeCloseTo(4500)

    // Grand total: EOP = latest quarter's value = Q2 = 4500
    expect(findRow(rows, { quarter: null }).balance).toBeCloseTo(4500)
  })

  it('mixed entity + time row dims: region + quarter on rows', async () => {
    const schema = baseSchema({ timeAgg: 'weighted_avg' })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      measures: ['balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per (region, quarter):
    //   APAC Q1: avg(1000,1100,1200) = 1100
    //   APAC Q2: avg(1300,1400,1500) = 1400
    //   EMEA Q1: avg(2000,2200,2400) = 2200
    //   EMEA Q2: avg(2600,2800,3000) = 2800
    expect(findRow(rows, { region: 'APAC', quarter: 1 }).balance).toBeCloseTo(1100)
    expect(findRow(rows, { region: 'APAC', quarter: 2 }).balance).toBeCloseTo(1400)
    expect(findRow(rows, { region: 'EMEA', quarter: 1 }).balance).toBeCloseTo(2200)
    expect(findRow(rows, { region: 'EMEA', quarter: 2 }).balance).toBeCloseTo(2800)

    // Per region (quarter collapsed → weighted avg across all 6 months):
    //   APAC: avg(1000,1100,1200,1300,1400,1500) = 1250
    //   EMEA: avg(2000,2200,2400,2600,2800,3000) = 2500
    expect(findRow(rows, { region: 'APAC', quarter: null }).balance).toBeCloseTo(1250)
    expect(findRow(rows, { region: 'EMEA', quarter: null }).balance).toBeCloseTo(2500)

    // Grand total (both collapsed): SUM of region time-averages = 1250+2500 = 3750
    expect(findRow(rows, { region: null, quarter: null }).balance).toBeCloseTo(3750)
  })

  it('mixed flow + stock with quarter on rows', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      measures: ['revenue', 'balance'],
    })

    const rows = await queryAll(conn, result.sql)

    // Per quarter revenue (flow = SUM):
    //   Q1: (100+200+300)+(10+20+30) = 660
    //   Q2: (400+500+600)+(40+50+60) = 1650
    expect(findRow(rows, { quarter: 1 }).revenue).toBeCloseTo(660)
    expect(findRow(rows, { quarter: 2 }).revenue).toBeCloseTo(1650)

    // Grand total: flow SUMs, stock averages
    expect(findRow(rows, { quarter: null }).revenue).toBeCloseTo(2310)   // sum
    expect(findRow(rows, { quarter: null }).balance).toBeCloseTo(3750)   // weighted avg
  })

  it('quarter on rows with limitRows (flat mode + two-pass)', async () => {
    const schema = baseSchema({ timeAgg: 'weighted_avg' })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      measures: ['balance'],
      limitRows: 1,  // top 1 quarter by SUM(balance) DESC → Q2 (higher values)
    })

    const rows = await queryAll(conn, result.sql)

    const leafRows = rollupRows(rows).filter(row => Number(row._g_quarter) === 0)
    expect(leafRows.length).toBe(1)

    // Top quarter is Q2 (monthly totals 3900+4200+4500 = 12600 > Q1's 9900)
    expect(findRow(rows, { quarter: 2 }).balance).toBeCloseTo(4200)

    // Grand total: weighted avg of only Q2's months = same as Q2 value
    expect(findRow(rows, { quarter: null }).balance).toBeCloseTo(4200)
  })
})

// ── Sort expression tests ──────────────────────────────────────────────

describe('sortExpression', () => {
  it('uses MIN(sortExpression) in ORDER BY for single-pass rollup', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', expression: 'MONTHNAME("date")', sortExpression: 'MONTH("date")' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month_name'],
      measures: ['revenue'],
    })
    expect(result.sql).toContain('MIN(MONTH("date"))')
    // GROUPING() still references the dim expression, but the sort value is MIN(MONTH(...))
    expect(result.sql).toMatch(/ORDER BY GROUPING\(MONTHNAME.*\), MIN\(MONTH/)
  })

  // The percentage wrapper selects the rollup as a CTE and orders by the
  // _sort_<dim> alias. The rollup used not to emit that column, so a dimension
  // with a sortExpression combined with any percent mode built SQL referencing a
  // column nothing produced, and the query failed at bind time.
  it('emits the _sort_ column the percentage wrapper orders by', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', expression: 'MONTHNAME("date")', sortExpression: 'MONTH("date")' },
        { id: 'region', sourceField: 'region' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    for (const displayMode of ['pct_row', 'pct_col', 'pct_total'] as const) {
      const result = qb.buildRollupAggregation({
        rowDimensions: ['month_name'],
        columnDimensions: ['region'],
        measures: ['revenue'],
        displayMode,
      })
      expect(result.sql).toContain('AS "_sort_month_name"')
      // Every ordered alias has to be produced by the CTE it selects from.
      for (const alias of result.sql.match(/ORDER BY (.+)$/m)?.[1].split(', ') ?? []) {
        if (alias.startsWith('"_sort_')) {
          expect(result.sql).toContain(`AS ${alias}`)
        }
      }
    }
  })

  it('uses MIN(sortExpression) in ORDER BY for flat aggregation', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', expression: 'MONTHNAME("date")', sortExpression: 'MONTH("date")' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['month_name'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
    })
    expect(result.sql).toContain('MIN(MONTH("date"))')
  })

  it('carries sort columns through _filtered CTE in flat mode', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', expression: 'MONTHNAME("date")', sortExpression: 'MONTH("date")' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month_name'],
      measures: ['revenue'],
      limitRows: 5,
    })
    // _filtered CTE should include the sort column
    expect(result.sql).toContain('"_sort_month_name"')
    // Outer ORDER BY should reference the sort alias
    expect(result.sql).toContain('MIN("_sort_month_name")')
  })
})

// ── Time dims on both axes tests ──────────────────────────────────────

describe('buildTimeCteRollup — both axes', () => {
  let db: InstanceType<typeof duckdb.Database>
  let conn: InstanceType<typeof duckdb.Connection>

  const queryAll = (c: InstanceType<typeof duckdb.Connection>, sql: string) =>
    new Promise<any[]>((resolve, reject) =>
      c.all(sql, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows))
    )

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = new duckdb.Connection(db)
    // 6 months, 2 regions — monthly headcount stock measure
    await queryAll(conn, `
      CREATE TABLE data (month DATE, region VARCHAR, headcount DOUBLE);
      INSERT INTO data VALUES
        (DATE '2024-01-01', 'NA',   100),
        (DATE '2024-02-01', 'NA',   110),
        (DATE '2024-03-01', 'NA',   120),
        (DATE '2024-04-01', 'NA',   130),
        (DATE '2024-05-01', 'NA',   140),
        (DATE '2024-06-01', 'NA',   150),
        (DATE '2024-01-01', 'EMEA', 200),
        (DATE '2024-02-01', 'EMEA', 210),
        (DATE '2024-03-01', 'EMEA', 220),
        (DATE '2024-04-01', 'EMEA', 230),
        (DATE '2024-05-01', 'EMEA', 240),
        (DATE '2024-06-01', 'EMEA', 250);
    `)
  })

  afterAll(() => { db?.close() })

  // Helper to find row by dimension values (handles BigInt from DuckDB)
  const findRow = (rs: any[], match: Record<string, any>) =>
    rs.find(r => Object.entries(match).every(([k, v]) => {
      if (v === null) return r[k] === null
      if (typeof v === 'string') return String(r[k]) === v
      return Number(r[k]) === v
    }))!

  it('weighted_avg: time dims on both rows and columns, correct grand total', async () => {
    // quarter on rows, year on columns (trivially one year)
    // Month Name on rows would also trigger this, but quarter is easier to test
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'headcount', sourceField: 'headcount', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['year'],
      measures: ['headcount'],
    })

    const rows = await queryAll(conn, result.sql)

    // Q1 (months 1,2,3): NA avg = (100+110+120)/3 = 110, EMEA avg = (200+210+220)/3 = 210
    // Total Q1 = 110 + 210 = 320
    const q1Total = findRow(rows, { quarter: 1, year: null })
    expect(q1Total.headcount).toBeCloseTo(320)

    // Q2 (months 4,5,6): NA avg = (130+140+150)/3 = 140, EMEA avg = (230+240+250)/3 = 240
    // Total Q2 = 140 + 240 = 380
    const q2Total = findRow(rows, { quarter: 2, year: null })
    expect(q2Total.headcount).toBeCloseTo(380)

    // Grand total: avg across all 6 months = (100+110+120+130+140+150+200+210+220+230+240+250)/6 = 350
    // NOT SUM(320, 380) = 700
    const grandTotal = findRow(rows, { quarter: null, year: null })
    expect(grandTotal.headcount).toBeCloseTo(350)
  })

  it('eop with time on both axes: last-period value per quarter, correct grand total', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'headcount', sourceField: 'headcount', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['year'],
      measures: ['headcount'],
    })

    const rows = await queryAll(conn, result.sql)

    // Q1 eop: last month is March. NA=120, EMEA=220 => total=340
    const q1Total = findRow(rows, { quarter: 1, year: null })
    expect(q1Total.headcount).toBeCloseTo(340)

    // Q2 eop: last month is June. NA=150, EMEA=250 => total=400
    const q2Total = findRow(rows, { quarter: 2, year: null })
    expect(q2Total.headcount).toBeCloseTo(400)

    // Grand total eop: last month across all data is June => NA=150, EMEA=250 => 400
    const grandTotal = findRow(rows, { quarter: null, year: null })
    expect(grandTotal.headcount).toBeCloseTo(400)
  })

  it('mixed flow + stock: flow uses SUM totals, stock uses weighted_avg', async () => {
    // Add a revenue column to the test data
    await queryAll(conn, `
      CREATE OR REPLACE TABLE data2 AS
        SELECT month, region, headcount,
               CASE region WHEN 'NA' THEN MONTH(month) * 1000.0 ELSE MONTH(month) * 500.0 END AS revenue
        FROM data;
    `)

    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum', timeAggregation: 'flow' },
        { id: 'headcount', sourceField: 'headcount', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['year'],
      measures: ['revenue', 'headcount'],
      source: 'data2',
    })

    const rows = await queryAll(conn, result.sql)

    // Q1 revenue (flow, SUM): NA = 1000+2000+3000=6000, EMEA = 500+1000+1500=3000, total=9000
    const q1Total = findRow(rows, { quarter: 1, year: null })
    expect(q1Total.revenue).toBeCloseTo(9000)
    // Q1 headcount (weighted_avg): NA avg=(100+110+120)/3=110, EMEA avg=(200+210+220)/3=210, total=320
    expect(q1Total.headcount).toBeCloseTo(320)

    // Q2 revenue (flow, SUM): NA = 4000+5000+6000=15000, EMEA = 2000+2500+3000=7500, total=22500
    const q2Total = findRow(rows, { quarter: 2, year: null })
    expect(q2Total.revenue).toBeCloseTo(22500)
    // Q2 headcount (weighted_avg): NA avg=(130+140+150)/3=140, EMEA avg=(230+240+250)/3=240, total=380
    expect(q2Total.headcount).toBeCloseTo(380)

    // Grand total revenue (flow): 9000+22500 = 31500
    const grandTotal = findRow(rows, { quarter: null, year: null })
    expect(grandTotal.revenue).toBeCloseTo(31500)
    // Grand total headcount (weighted_avg): all 6 months avg = 350
    expect(grandTotal.headcount).toBeCloseTo(350)
  })

  it('non-time dim alongside time dims: region gets ROLLUP, time dims get CTE collapse', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'headcount', sourceField: 'headcount', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      columnDimensions: ['year'],
      measures: ['headcount'],
    })

    const rows = await queryAll(conn, result.sql)

    // NA, Q1: avg of months 1-3 = (100+110+120)/3 = 110
    const naQ1 = findRow(rows, { region: 'NA', quarter: 1, year: null })
    expect(naQ1.headcount).toBeCloseTo(110)

    // NA, Q2: avg of months 4-6 = (130+140+150)/3 = 140
    const naQ2 = findRow(rows, { region: 'NA', quarter: 2, year: null })
    expect(naQ2.headcount).toBeCloseTo(140)

    // NA total (quarter=null): avg across all 6 NA months = (100+110+120+130+140+150)/6 = 125
    const naTotal = findRow(rows, { region: 'NA', quarter: null, year: null })
    expect(naTotal.headcount).toBeCloseTo(125)

    // EMEA total (quarter=null): avg across all 6 EMEA months = (200+210+220+230+240+250)/6 = 225
    const emeaTotal = findRow(rows, { region: 'EMEA', quarter: null, year: null })
    expect(emeaTotal.headcount).toBeCloseTo(225)

    // Grand total (region=null, quarter=null): sum of region avgs = 125+225 = 350
    const grandTotal = findRow(rows, { region: null, quarter: null, year: null })
    expect(grandTotal.headcount).toBeCloseTo(350)
  })

  it('day weighting: weighted_avg uses day counts per month, not equal weights', async () => {
    // Use non-linear headcount so day weighting produces visibly different results.
    // High headcount in Feb (29 days in 2024 leap year) vs Jan/Mar (31 days each)
    // makes the day-weighted average meaningfully different from equal-weight.
    await queryAll(conn, `
      CREATE OR REPLACE TABLE data_days (month DATE, region VARCHAR, headcount DOUBLE);
      INSERT INTO data_days VALUES
        (DATE '2024-01-01', 'NA',   100),
        (DATE '2024-02-01', 'NA',   400),
        (DATE '2024-03-01', 'NA',   100),
        (DATE '2024-04-01', 'NA',   130),
        (DATE '2024-05-01', 'NA',   140),
        (DATE '2024-06-01', 'NA',   150),
        (DATE '2024-01-01', 'EMEA', 200),
        (DATE '2024-02-01', 'EMEA', 500),
        (DATE '2024-03-01', 'EMEA', 200),
        (DATE '2024-04-01', 'EMEA', 230),
        (DATE '2024-05-01', 'EMEA', 240),
        (DATE '2024-06-01', 'EMEA', 250);
    `)

    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'headcount', sourceField: 'headcount', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'days' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['year'],
      measures: ['headcount'],
      source: 'data_days',
    })

    const rows = await queryAll(conn, result.sql)

    // Q1 day-weighted: Jan=31d, Feb=29d (2024 leap year), Mar=31d => total 91 days
    // NA: (100*31 + 400*29 + 100*31) / 91 = (3100+11600+3100) / 91 = 17800/91 ≈ 195.6
    // EMEA: (200*31 + 500*29 + 200*31) / 91 = (6200+14500+6200) / 91 = 26900/91 ≈ 295.6
    const q1Total = findRow(rows, { quarter: 1, year: null })
    const naQ1DayWeighted = (100*31 + 400*29 + 100*31) / 91
    const emeaQ1DayWeighted = (200*31 + 500*29 + 200*31) / 91
    expect(q1Total.headcount).toBeCloseTo(naQ1DayWeighted + emeaQ1DayWeighted, 1)

    // Equal weight Q1 would be: (100+400+100)/3 + (200+500+200)/3 = 200 + 300 = 500
    // Day weighted Q1: ~195.6 + ~295.6 = ~491.2 — measurably different
    const equalWeightQ1 = (100+400+100)/3 + (200+500+200)/3  // = 500
    expect(Math.abs(q1Total.headcount - equalWeightQ1)).toBeGreaterThan(1)

    // Grand total day-weighted: all 6 months, 182 total days
    const grandTotal = findRow(rows, { quarter: null, year: null })
    const naDays = 100*31 + 400*29 + 100*31 + 130*30 + 140*31 + 150*30
    const emeaDays = 200*31 + 500*29 + 200*31 + 230*30 + 240*31 + 250*30
    const totalDays = 31 + 29 + 31 + 30 + 31 + 30
    const expectedGrand = naDays/totalDays + emeaDays/totalDays
    expect(grandTotal.headcount).toBeCloseTo(expectedGrand, 1)
  })
})

// ── Flat mode + CTE rollup combinations ──────────────────────────────
//
// These tests exercise limitRows/limitCols flowing through the CTE rollup
// paths: buildTimeCteRollup (col-only, row-only, and both-axes variants).
// The flatCtes array (_top_rows, _top_cols) is built in buildTwoPassRollup
// and passed into each CTE builder. No prior test exercises limitCols in
// any CTE path, or any limiting in the time-on-columns or time-on-both paths.

describe('flat mode + CTE rollup combinations', () => {
  let db: any
  let conn: any

  // 4 categories × 2 regions × 6 months — enough to test limit=2 meaningfully.
  // Balance grows by 10% each month to produce distinct values.
  // SUM(balance) ordering: Alpha > Beta > Gamma > Delta (per region and overall).
  // Region ordering by SUM: NA > EMEA.

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        category VARCHAR,
        region VARCHAR,
        month DATE,
        balance DOUBLE
      );
    `)
    const bases: [string, string, number][] = [
      ['Alpha', 'NA',   1000],
      ['Alpha', 'EMEA',  800],
      ['Beta',  'NA',    500],
      ['Beta',  'EMEA',  400],
      ['Gamma', 'NA',    100],
      ['Gamma', 'EMEA',   80],
      ['Delta', 'NA',     50],
      ['Delta', 'EMEA',   40],
    ]
    const months = [
      '2025-01-01', '2025-02-01', '2025-03-01',
      '2025-04-01', '2025-05-01', '2025-06-01',
    ]
    const values: string[] = []
    for (const [cat, reg, base] of bases) {
      for (let i = 0; i < months.length; i++) {
        const val = Math.round(base * Math.pow(1.1, i) * 100) / 100
        values.push(`('${cat}', '${reg}', DATE '${months[i]}', ${val})`)
      }
    }
    await exec(conn, `INSERT INTO data VALUES ${values.join(',\n')}`)
  })

  afterAll(() => { db?.close() })

  // Schema with quarter (time-derived) and category/region as regular dims.
  const makeTestSchema = (opts: { timeAgg?: string } = {}) => makeSchema({
    dimensions: [
      { id: 'category', sourceField: 'category' },
      { id: 'region', sourceField: 'region' },
      { id: 'month', sourceField: 'month' },
      { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
    ],
    measures: [
      { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: opts.timeAgg ?? 'weighted_avg' },
    ],
    timeDimensions: [
      { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
    ],
  })

  it('limitCols + time on columns: only top-4 (category,quarter) tuples, time collapse correct', async () => {
    // quarter on columns (time-derived), category also on columns, region on rows.
    // limitCols limits (category, quarter) tuples. With 4 cats × 2 quarters = 8
    // tuples, limitCols=4 keeps the top 4 by SUM(balance) — effectively Alpha
    // and Beta (each contributing 2 quarter tuples).
    const schema = makeTestSchema()
    const qb = new QueryBuilder(schema)

    // Unlimited reference
    const refResult = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['category', 'quarter'],
      measures: ['balance'],
    })
    const refRows = await queryAll(conn, refResult.sql)

    // Limited to top 4 (category, quarter) tuples
    const limResult = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['category', 'quarter'],
      measures: ['balance'],
      limitCols: 4,
    })
    const limRows = await queryAll(conn, limResult.sql)

    expect(limResult.sql).toContain('_top_cols')
    expect(limResult.sql).toContain('LIMIT 4')

    // Top 4 tuples by SUM(balance): Alpha has the highest per-tuple sums,
    // then Beta. So we expect Alpha and Beta categories only.
    const limLeafCategories = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_category) === 0)
        .map(r => r.category)
    )
    expect(limLeafCategories.size).toBe(2)
    expect(limLeafCategories.has('Alpha')).toBe(true)
    expect(limLeafCategories.has('Beta')).toBe(true)
    expect(limLeafCategories.has('Gamma')).toBe(false)
    expect(limLeafCategories.has('Delta')).toBe(false)

    // Per-quarter values for included categories should match reference
    const refNaAlphaQ1 = findRow(refRows, { region: 'NA', category: 'Alpha', quarter: 1 })
    const limNaAlphaQ1 = findRow(limRows, { region: 'NA', category: 'Alpha', quarter: 1 })
    expect(limNaAlphaQ1.balance).toBeCloseTo(refNaAlphaQ1.balance, 1)

    const refNaBetaQ1 = findRow(refRows, { region: 'NA', category: 'Beta', quarter: 1 })
    const limNaBetaQ1 = findRow(limRows, { region: 'NA', category: 'Beta', quarter: 1 })
    expect(limNaBetaQ1.balance).toBeCloseTo(refNaBetaQ1.balance, 1)

    // Column total (all col dims collapsed) for NA should use weighted_avg,
    // and should match reference since the included categories are the same.
    const refNaTotal = findRow(refRows, { region: 'NA', category: null, quarter: null })
    const limNaTotal = findRow(limRows, { region: 'NA', category: null, quarter: null })
    // Limited total should be less than ref (fewer categories included)
    expect(limNaTotal.balance).toBeLessThan(refNaTotal.balance + 0.01)
  })

  it('limitRows + time on columns: only top-2 row values, column time collapse correct', async () => {
    // quarter on columns (time-derived), category on rows with limitRows=2.
    const schema = makeTestSchema()
    const qb = new QueryBuilder(schema)

    // Unlimited reference
    const refResult = qb.buildRollupAggregation({
      rowDimensions: ['category'],
      columnDimensions: ['quarter'],
      measures: ['balance'],
    })
    const refRows = await queryAll(conn, refResult.sql)

    // Limited to top 2 categories on rows
    const limResult = qb.buildRollupAggregation({
      rowDimensions: ['category'],
      columnDimensions: ['quarter'],
      measures: ['balance'],
      limitRows: 2,
    })
    const limRows = await queryAll(conn, limResult.sql)

    expect(limResult.sql).toContain('_top_rows')
    expect(limResult.sql).toContain('LIMIT 2')
    expect(limResult.sql).not.toContain('_top_cols')

    // Only top-2 categories by SUM(balance): Alpha and Beta
    const limLeafCategories = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_category) === 0)
        .map(r => r.category)
    )
    expect(limLeafCategories.size).toBe(2)
    expect(limLeafCategories.has('Alpha')).toBe(true)
    expect(limLeafCategories.has('Beta')).toBe(true)

    // Time collapse on columns should still be correct for included rows.
    // Alpha total column (quarter=null) should match reference.
    const refAlphaTotal = findRow(refRows, { category: 'Alpha', quarter: null })
    const limAlphaTotal = findRow(limRows, { category: 'Alpha', quarter: null })
    expect(limAlphaTotal.balance).toBeCloseTo(refAlphaTotal.balance, 1)

    // Per-quarter values should match
    const refAlphaQ1 = findRow(refRows, { category: 'Alpha', quarter: 1 })
    const limAlphaQ1 = findRow(limRows, { category: 'Alpha', quarter: 1 })
    expect(limAlphaQ1.balance).toBeCloseTo(refAlphaQ1.balance, 1)
  })

  it('limitCols + time on rows: only top-2 column values, row time collapse correct', async () => {
    // quarter on rows (time-derived), category on columns with limitCols=2.
    const schema = makeTestSchema()
    const qb = new QueryBuilder(schema)

    const refResult = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['category'],
      measures: ['balance'],
    })
    const refRows = await queryAll(conn, refResult.sql)

    const limResult = qb.buildRollupAggregation({
      rowDimensions: ['quarter'],
      columnDimensions: ['category'],
      measures: ['balance'],
      limitCols: 2,
    })
    const limRows = await queryAll(conn, limResult.sql)

    expect(limResult.sql).toContain('_top_cols')
    expect(limResult.sql).toContain('LIMIT 2')
    expect(limResult.sql).not.toContain('_top_rows')

    // Only top-2 categories: Alpha and Beta
    const limLeafCategories = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_category) === 0)
        .map(r => r.category)
    )
    expect(limLeafCategories.size).toBe(2)
    expect(limLeafCategories.has('Alpha')).toBe(true)
    expect(limLeafCategories.has('Beta')).toBe(true)

    // Row time collapse: Q1 value for Alpha should match reference
    const refAlphaQ1 = findRow(refRows, { quarter: 1, category: 'Alpha' })
    const limAlphaQ1 = findRow(limRows, { quarter: 1, category: 'Alpha' })
    expect(limAlphaQ1.balance).toBeCloseTo(refAlphaQ1.balance, 1)

    // Quarter total (quarter=null) for Alpha should match reference
    const refAlphaTotal = findRow(refRows, { quarter: null, category: 'Alpha' })
    const limAlphaTotal = findRow(limRows, { quarter: null, category: 'Alpha' })
    expect(limAlphaTotal.balance).toBeCloseTo(refAlphaTotal.balance, 1)

    // Grand total should be bounded to the 2 included categories
    const grandTotal = findRow(limRows, { quarter: null, category: null })
    const refAlpha = findRow(refRows, { quarter: null, category: 'Alpha' })
    const refBeta = findRow(refRows, { quarter: null, category: 'Beta' })
    expect(grandTotal.balance).toBeCloseTo(refAlpha.balance + refBeta.balance, 0)
  })

  it('both limits + time on both axes: limiting works on both axes with correct time collapse', async () => {
    // quarter on rows (time-derived), year on columns (time-derived),
    // category on columns (non-time), region on rows (non-time).
    // limitRows limits (region, quarter) tuples; limitCols limits (category, year) tuples.
    // With 1 year, limitCols=2 effectively limits to top-2 categories.
    // With 2 regions × 2 quarters = 4 tuples, limitRows=4 keeps all (tests CTE generation).
    const schema = makeSchema({
      dimensions: [
        { id: 'category', sourceField: 'category' },
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
        { id: 'year', sourceField: 'year', expression: 'YEAR("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(schema)

    const refResult = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      columnDimensions: ['category', 'year'],
      measures: ['balance'],
    })
    const refRows = await queryAll(conn, refResult.sql)

    const limResult = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      columnDimensions: ['category', 'year'],
      measures: ['balance'],
      limitRows: 4,   // (region, quarter) tuples — 4 exist, keeps all but generates CTE
      limitCols: 2,   // (category, year) tuples — keeps top 2 (Alpha, Beta with year=2025)
    })
    const limRows = await queryAll(conn, limResult.sql)

    // Both CTE types should be present
    expect(limResult.sql).toContain('_top_rows')
    expect(limResult.sql).toContain('_top_cols')

    // Column limiting: only top-2 (category, year) tuples → Alpha and Beta
    const limLeafCategories = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_category) === 0)
        .map(r => r.category)
    )
    expect(limLeafCategories.size).toBe(2)
    expect(limLeafCategories.has('Alpha')).toBe(true)
    expect(limLeafCategories.has('Beta')).toBe(true)

    // Row limiting with limit=4 keeps all 4 (region, quarter) tuples
    const limLeafRegions = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_region) === 0)
        .map(r => r.region)
    )
    expect(limLeafRegions.size).toBe(2)
    expect(limLeafRegions.has('NA')).toBe(true)
    expect(limLeafRegions.has('EMEA')).toBe(true)

    // Detail values: NA + Alpha in Q1, year=2025 should match reference
    const refNaAlphaQ1 = findRow(refRows, { region: 'NA', quarter: 1, category: 'Alpha', year: 2025 })
    const limNaAlphaQ1 = findRow(limRows, { region: 'NA', quarter: 1, category: 'Alpha', year: 2025 })
    expect(limNaAlphaQ1.balance).toBeCloseTo(refNaAlphaQ1.balance, 1)

    // Row time collapse: NA with quarter collapsed, all col dims collapsed
    const refNaTotal = findRow(refRows, { region: 'NA', quarter: null, category: null, year: null })
    const limNaTotal = findRow(limRows, { region: 'NA', quarter: null, category: null, year: null })
    // Limited column total for NA should be less (fewer categories)
    expect(limNaTotal.balance).toBeLessThan(refNaTotal.balance + 0.01)
    expect(limNaTotal.balance).toBeGreaterThan(0)

    // Grand total should reflect bounded set and be positive
    const grandTotal = findRow(limRows, { region: null, quarter: null, category: null, year: null })
    expect(grandTotal.balance).toBeGreaterThan(0)

    // Grand total for limited set should be <= unlimited grand total
    const refGrandTotal = findRow(refRows, { region: null, quarter: null, category: null, year: null })
    expect(grandTotal.balance).toBeLessThanOrEqual(refGrandTotal.balance + 0.01)
  })

  it('limitCols only (no limitRows) + two-pass: only column limiting CTEs generated', async () => {
    // category on columns with limitCols=2, region+quarter on rows, no limitRows.
    // Should have _top_cols but NOT _top_rows, and row results should be complete.
    const schema = makeTestSchema()
    const qb = new QueryBuilder(schema)

    const limResult = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      columnDimensions: ['category'],
      measures: ['balance'],
      limitCols: 2,
    })
    const limRows = await queryAll(conn, limResult.sql)

    expect(limResult.sql).toContain('_top_cols')
    expect(limResult.sql).not.toContain('_top_rows')

    // All regions should be present (no row limiting)
    const limLeafRegions = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_region) === 0)
        .map(r => r.region)
    )
    expect(limLeafRegions.size).toBe(2)
    expect(limLeafRegions.has('NA')).toBe(true)
    expect(limLeafRegions.has('EMEA')).toBe(true)

    // All quarters should be present (no row limiting)
    const limLeafQuarters = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_quarter) === 0 && Number(r._g_region) === 0)
        .map(r => Number(r.quarter))
    )
    expect(limLeafQuarters.size).toBe(2)
    expect(limLeafQuarters.has(1)).toBe(true)
    expect(limLeafQuarters.has(2)).toBe(true)

    // Only top-2 categories on columns
    const limLeafCategories = new Set(
      rollupRows(limRows)
        .filter(r => Number(r._g_category) === 0)
        .map(r => r.category)
    )
    expect(limLeafCategories.size).toBe(2)
    expect(limLeafCategories.has('Alpha')).toBe(true)
    expect(limLeafCategories.has('Beta')).toBe(true)

    // Reference: compare an included category's value
    const refResult = qb.buildRollupAggregation({
      rowDimensions: ['region', 'quarter'],
      columnDimensions: ['category'],
      measures: ['balance'],
    })
    const refRows = await queryAll(conn, refResult.sql)

    const refNaAlpha = findRow(refRows, { region: 'NA', quarter: null, category: 'Alpha' })
    const limNaAlpha = findRow(limRows, { region: 'NA', quarter: null, category: 'Alpha' })
    expect(limNaAlpha.balance).toBeCloseTo(refNaAlpha.balance, 1)
  })
})

describe('preAggregated sort columns', () => {
  // A summary view emits no _sort_ columns, because the source columns a
  // sortExpression names need not exist in it. Anything selecting from that
  // query has to agree, or it passes through a column nothing produced and the
  // query fails at bind time with "Referenced column _sort_<dim> not found".
  it('does not pass through a sort column a summary view never emitted', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', sortExpression: 'MONTH("date")' },
        { id: 'region', sourceField: 'region' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month_name'],
      columnDimensions: ['region'],
      measures: ['revenue'],
      source: 'sv_test',
      preAggregated: true,
      limitRows: 10,
    })
    expect(result.sql).not.toContain('_sort_month_name')
  })

  // The time-CTE path reports which sort columns it produced, and a later
  // wrapper picks its tie-break key from that list. Reporting one the summary
  // view never emitted fails at bind time a wrapper further out, which is the
  // same fault as above wearing a different hat.
  it('reports no sort columns from the time-CTE path over a summary view', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region', sortExpression: 'LENGTH("region")' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'balance', sourceField: 'balance', aggregation: 'sum', timeAggregation: 'eop' },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['month'],
      measures: ['balance'],
      source: 'sv_test',
      preAggregated: true,
      sort: { by: 'measure', measure: 'balance', axis: 'rows', direction: 'desc' },
    })
    expect(result.sql).not.toContain('_sort_region')
  })

  it('still passes the sort column through against base data', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month_name', sourceField: 'month_name', sortExpression: 'MONTH("date")' },
        { id: 'region', sourceField: 'region' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['month_name'],
      columnDimensions: ['region'],
      measures: ['revenue'],
      limitRows: 10,
    })
    // Every _sort_ alias referenced has to be one this query also produces.
    for (const ref of result.sql.match(/"_sort_[a-z_]+"/g) ?? []) {
      expect(result.sql).toContain(`AS ${ref}`)
    }
  })
})

describe('preAggregated derived dimensions', () => {
  it('uses expressions consistently in GROUP BY, GROUPING, and SELECT', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month', sourceField: 'month' },
        { id: 'year', displayName: 'Year', expression: 'YEAR(CAST("month" AS DATE))', derivedFromField: 'month' },
        { id: 'quarter', displayName: 'Quarter', expression: 'QUARTER(CAST("month" AS DATE))', derivedFromField: 'month' },
        { id: 'metric_type', sourceField: 'metric_type' },
      ],
      measures: [{ id: 'amount', sourceField: 'amount' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['year', 'quarter'],
      columnDimensions: ['metric_type'],
      measures: ['amount'],
      source: 'sv_test',
      preAggregated: true,
    })

    // GROUP BY should use expressions for derived dims, not aliases
    expect(result.sql).toContain('ROLLUP(YEAR(CAST("month" AS DATE))')
    expect(result.sql).toContain('QUARTER(CAST("month" AS DATE))')
    // GROUPING should use expressions too
    expect(result.sql).toContain('GROUPING(YEAR(CAST("month" AS DATE)))')
    // Column dim (physical) should use quoteIdent
    expect(result.sql).toContain('GROUPING SETS(("metric_type"), ())')
    // No duplicate _g_ columns
    const gYearMatches = result.sql.match(/"_g_year"/g)
    expect(gYearMatches?.length).toBe(1)
  })

  it('deduplicates when same dim is on both rows and columns', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'year', sourceField: 'year' },
        { id: 'quarter', sourceField: 'quarter' },
      ],
      measures: [{ id: 'amount', sourceField: 'amount' }],
    })
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['year', 'quarter'],
      columnDimensions: ['year'],
      measures: ['amount'],
    })

    // year should appear only once in groupingColumns and dimensionFields
    expect(result.groupingColumns).toEqual(['_g_year', '_g_quarter'])
    expect(result.dimensionFields).toEqual(['year', 'quarter'])
    expect(result.rowDimensionCount).toBe(2)
    // No GROUPING SETS — year is already in the ROLLUP
    expect(result.sql).not.toContain('GROUPING SETS')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Filters / buildWhereClause
// ═════════════════════════════════════════════════════════════════════

describe('filters / buildWhereClause', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        country VARCHAR,
        city VARCHAR,
        month DATE,
        revenue DOUBLE,
        units INTEGER
      );
      INSERT INTO data VALUES
        ('APAC', 'AU',  'Sydney',     DATE '2025-01-01', 100, 10),
        ('APAC', 'AU',  'Melbourne',  DATE '2025-02-01', 200, 20),
        ('APAC', 'JP',  'Tokyo',      DATE '2025-01-01', 300, 30),
        ('APAC', 'JP',  'Osaka',      DATE '2025-02-01', 400, 40),
        ('EMEA', 'UK',  'London',     DATE '2025-01-01', 50,  5),
        ('EMEA', 'UK',  'Manchester', DATE '2025-02-01', 60,  6),
        ('EMEA', 'DE',  'Berlin',     DATE '2025-01-01', 70,  7),
        ('EMEA', 'DE',  'Munich',     DATE '2025-02-01', 80,  8),
        ('AMER', 'US',  'New York',   DATE '2025-01-01', 500, 50),
        ('AMER', 'US',  'Chicago',    DATE '2025-02-01', 600, 60),
        ('AMER', 'CA',  'Toronto',    DATE '2025-01-01', 150, 15),
        ('AMER', 'CA',  'Vancouver',  DATE '2025-02-01', 250, 25);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
      { id: 'city', sourceField: 'city' },
      { id: 'month', sourceField: 'month' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      { id: 'units', sourceField: 'units', aggregation: 'sum' },
    ]
  })

  // 1. = operator with string value
  it('= operator with string value filters to matching rows', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'country', operator: '=', value: 'US' }],
    })

    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(1)
    expect(rows[0].country).toBe('US')
    expect(rows[0].revenue).toBeCloseTo(1100)  // 500 + 600
  })

  // 2. = operator with numeric value
  it('= operator with numeric value filters correctly', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['city'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'units', operator: '=', value: 50 }],
    })

    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(1)
    expect(rows[0].city).toBe('New York')
    expect(rows[0].revenue).toBeCloseTo(500)
  })

  // 3. in operator
  it('in operator filters to matching values', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'country', operator: 'in', value: ['US', 'UK'] }],
    })

    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(2)
    const countries = rows.map((r: any) => r.country).sort()
    expect(countries).toEqual(['UK', 'US'])
  })

  // 4. not_in operator
  it('not_in operator excludes matching values', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'country', operator: 'not_in', value: ['US', 'UK', 'CA'] }],
    })

    const rows = await queryAll(conn, result.sql)
    // Remaining: AU, JP, DE
    const countries = rows.map((r: any) => r.country).sort()
    expect(countries).toEqual(['AU', 'DE', 'JP'])
  })

  // 5. Empty in array returns zero rows
  it('empty in array returns zero data rows', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'country', operator: 'in', value: [] }],
    })

    expect(result.sql).toContain('1=0')
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(0)
  })

  // 6. Empty not_in array returns all rows
  it('empty not_in array returns all rows', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'country', operator: 'not_in', value: [] }],
    })

    expect(result.sql).toContain('1=1')
    const rows = await queryAll(conn, result.sql)
    // All 6 countries
    expect(rows.length).toBe(6)
  })

  // 7. between operator with numbers
  it('between operator filters to values in range', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['city'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'revenue', operator: 'between', value: [100, 300] }],
    })

    const rows = await queryAll(conn, result.sql)
    // Rows with revenue 100..300: Sydney(100), Melbourne(200), Tokyo(300), Toronto(150), Vancouver(250)
    const cities = rows.map((r: any) => r.city).sort()
    expect(cities).toEqual(['Melbourne', 'Sydney', 'Tokyo', 'Toronto', 'Vancouver'])
  })

  // 8. like operator
  it('like operator matches pattern', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['city'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'city', operator: 'like', value: 'M%' }],
    })

    const rows = await queryAll(conn, result.sql)
    const cities = rows.map((r: any) => r.city).sort()
    expect(cities).toEqual(['Manchester', 'Melbourne', 'Munich'])
  })

  // 9. String value escaping (single quote)
  it('string with single quote does not break SQL', async () => {
    // Insert a row with a single quote in the city name
    await exec(conn, `
      INSERT INTO data VALUES ('EMEA', 'IE', 'O''Brien Town', DATE '2025-01-01', 99, 9);
    `)

    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['city'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'city', operator: '=', value: "O'Brien Town" }],
    })

    // Should not throw
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(1)
    expect(rows[0].city).toBe("O'Brien Town")
    expect(rows[0].revenue).toBeCloseTo(99)

    // Clean up
    await exec(conn, `DELETE FROM data WHERE city = 'O''Brien Town'`)
  })

  // 10. Derived dimension filter uses expression in WHERE
  it('derived dimension filter uses expression instead of quoting dim name', async () => {
    const derivedSchema = makeSchema({
      dimensions: [
        { id: 'country', sourceField: 'country' },
        { id: 'month', sourceField: 'month' },
        { id: 'quarter', sourceField: 'quarter', expression: 'QUARTER("month")', derivedFromField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ]
    })

    const qb = new QueryBuilder(derivedSchema)
    const result = qb.buildAggregation({
      dimensions: ['country'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'quarter', operator: '=', value: 1 }],
    })

    // The WHERE clause should use the expression QUARTER("month"), not "quarter"
    expect(result.sql).toContain('QUARTER("month")')
    expect(result.sql).not.toMatch(/WHERE[^Q]*"quarter"/)

    // All test data is Jan-Feb = Q1, so all rows match
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(6)  // all 6 countries
  })

  // 11. Filters flow through rollup — subtotals and grand total reflect only filtered data
  it('filters flow through rollup: subtotals and grand total reflect only filtered data', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue'],
      filters: [{ field: 'region', operator: 'in', value: ['APAC'] }],
    })

    const rows = await queryAll(conn, result.sql)

    // Only APAC countries should be present
    const leafRows = rollupRows(rows).filter(row =>
      result.groupingColumns.every(gc => Number(row[gc]) === 0)
    )
    const countries = leafRows.map((r: any) => r.country).sort()
    expect(countries).toEqual(['AU', 'JP'])

    // Country values
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).revenue).toBeCloseTo(300)  // 100+200
    expect(findRow(rows, { region: 'APAC', country: 'JP' }).revenue).toBeCloseTo(700)  // 300+400

    // Region subtotal: only APAC
    expect(findRow(rows, { region: 'APAC', country: null }).revenue).toBeCloseTo(1000)

    // Grand total: only APAC data
    expect(findRow(rows, { region: null, country: null }).revenue).toBeCloseTo(1000)
  })
})

// ── Edge cases / error handling ──────────────────────────────────────

describe('edge cases and error handling', () => {
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
        revenue DOUBLE,
        units INTEGER
      );
      INSERT INTO data VALUES
        ('APAC', 'AU', DATE '2025-01-01', 100, 10),
        ('APAC', 'JP', DATE '2025-02-01', 200, 20),
        ('EMEA', 'UK', DATE '2025-01-01', 50,  5);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      { id: 'units', sourceField: 'units', aggregation: 'sum' },
    ]
  })

  // 1. buildProbeQuery with empty dimension arrays
  it('buildProbeQuery with empty dimensions produces valid SQL', async () => {
    const qb = new QueryBuilder(schema)
    const sql = qb.buildProbeQuery({
      dimensions: [],
      probeLimit: 100,
    })

    // Should not contain GROUP BY
    expect(sql).not.toContain('GROUP BY')
    // Should be valid SQL and return a count
    const rows = await queryAll(conn, sql)
    expect(rows.length).toBe(1)
    expect(Number(rows[0].n)).toBe(3) // no GROUP BY, so inner query returns all 3 rows
  })

  // 2. buildRollupAggregation with no measures (dimensions only)
  it('buildRollupAggregation with no measures produces valid SQL', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: [],
    })

    // Should produce valid SQL with grouping columns but no aggregates
    expect(result.measureFields).toEqual([])
    expect(result.groupingColumns.length).toBe(2)

    const rows = await queryAll(conn, result.sql)
    // Should have detail rows + subtotals + grand total
    const rr = rollupRows(rows)
    expect(rr.length).toBeGreaterThan(0)

    // Grand total row should exist (both dims rolled up)
    const grandTotal = rr.find(r => Number(r._g_region) === 1 && Number(r._g_country) === 1)
    expect(grandTotal).toBeDefined()
  })

  // 3. buildRollupAggregation with unknown measure ID throws
  it('buildRollupAggregation with unknown measure ID throws', () => {
    const qb = new QueryBuilder(schema)
    expect(() => qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['nonexistent_measure'],
    })).toThrow('Unknown measure: nonexistent_measure')
  })

  // 4. buildRollupAggregation with unknown dimension ID generates SQL but fails at execution
  it('buildRollupAggregation with unknown dimension ID generates SQL referencing the unknown column', () => {
    const qb = new QueryBuilder(schema)
    // resolveDimExpr falls through to quoteIdent for unknown dims, so SQL generation succeeds
    const result = qb.buildRollupAggregation({
      rowDimensions: ['nonexistent_dim'],
      measures: ['revenue'],
    })

    // SQL is generated (no build-time error), but references a column that doesn't exist
    expect(result.sql).toContain('"nonexistent_dim"')
    expect(result.groupingColumns).toContain('_g_nonexistent_dim')
  })

  // 5. buildWhereConditions: NaN numeric value in '=' filter is skipped
  it('= filter with NaN value produces no WHERE clause', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'units', operator: '=', value: NaN }],
    })

    // NaN is skipped, so no WHERE clause — all rows returned
    expect(result.sql).not.toContain('WHERE')
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(2) // APAC, EMEA
  })

  // 6. buildWhereConditions: NaN in 'in' array is skipped, valid values kept
  it('in filter with NaN element skips only the NaN value', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'units', operator: 'in', value: [NaN, 10] }],
    })

    // NaN is filtered out, but 10 remains
    expect(result.sql).toContain('IN (10)')
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(1)
    expect(rows[0].region).toBe('APAC')
  })

  // 7. buildWhereConditions: all-NaN 'in' array produces 1=0 (no match)
  it('in filter with all NaN values produces 1=0', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'units', operator: 'in', value: [NaN, NaN] }],
    })

    expect(result.sql).toContain('1=0')
  })

  // 8. buildWhereConditions: NaN in 'between' range skips the clause
  it('between filter with NaN bound produces no WHERE clause', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue', aggregation: 'sum' }],
      filters: [{ field: 'revenue', operator: 'between', value: [NaN, 200] }],
    })

    // NaN bound causes the clause to be skipped
    expect(result.sql).not.toContain('BETWEEN')
    const rows = await queryAll(conn, result.sql)
    expect(rows.length).toBe(2) // all rows returned
  })
})

// ═════════════════════════════════════════════════════════════════════
// Custom aggregate measures
// ═════════════════════════════════════════════════════════════════════

describe('custom aggregation measures', () => {
  // Dataset: 2 departments × 3 rows each
  //   dept  | revenue | cost
  //   Sales | 1000    | 600
  //   Sales | 2000    | 1000
  //   Sales | 3000    | 1800
  //   Ops   | 500     | 200
  //   Ops   | 1500    | 900
  //   Ops   | 2000    | 1200

  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 1000, 600),
        ('Sales', 2000, 1000),
        ('Sales', 3000, 1800),
        ('Ops',    500,  200),
        ('Ops',   1500,  900),
        ('Ops',   2000, 1200);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [{ id: 'dept', sourceField: 'dept' }],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      { id: 'margin_pct', sourceField: 'revenue',
        aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  it('buildAggregation: custom expression is used as-is (no outer aggregate wrapper)', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: [],
      values: [{ field: 'margin_pct', aggregation: 'custom' }],
    })
    // Should not double-wrap — the expression already contains SUM
    expect(result.sql).not.toMatch(/SUM\s*\(\s*\(/)
    expect(result.sql).toContain('SUM("revenue") - SUM("cost")')
  })

  it('buildAggregation: custom measure returns correct value', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: [],
      values: [{ field: 'margin_pct', aggregation: 'custom' }],
    })
    // Total revenue = 10000, total cost = 5700, margin = (10000-5700)/10000*100 = 43
    const rows = await queryAll(conn, result.sql)
    expect(rows[0].margin_pct).toBeCloseTo(43)
  })

  it('buildAggregation: custom measure grouped by dimension returns per-group values', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['dept'],
      values: [{ field: 'margin_pct', aggregation: 'custom' }],
    })
    const rows = await queryAll(conn, result.sql)
    const sales = rows.find((r: any) => r.dept === 'Sales')
    const ops   = rows.find((r: any) => r.dept === 'Ops')
    // Sales: revenue=6000, cost=3400, margin=(6000-3400)/6000*100 ≈ 43.33
    expect(sales.margin_pct).toBeCloseTo(43.33, 1)
    // Ops: revenue=4000, cost=2300, margin=(4000-2300)/4000*100 = 42.5
    expect(ops.margin_pct).toBeCloseTo(42.5, 1)
  })

  it('buildRollupAggregation (single-pass): custom measure expression is not wrapped in outer agg', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
    })
    expect(result.sql).not.toMatch(/SUM\s*\(\s*\(/)
    expect(result.sql).toContain('SUM("revenue") - SUM("cost")')
  })

  it('buildRollupAggregation (single-pass): subtotals are computed correctly at grand total', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
    })
    const rows = await queryAll(conn, result.sql)
    // Grand total row: _g_dept = 1
    const grandTotal = rows.find((r: any) => r._g_dept === 1)
    // Total: revenue=10000, cost=5700, margin=43
    expect(grandTotal.margin_pct).toBeCloseTo(43)
  })

  it('buildRollupAggregation (single-pass): dept rows have correct per-dept margin', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['revenue', 'margin_pct'],
    })
    const rows = await queryAll(conn, result.sql)
    const sales = rows.find((r: any) => r.dept === 'Sales' && r._g_dept === 0)
    expect(sales.margin_pct).toBeCloseTo(43.33, 1)
  })

  it('buildFlatModeSinglePass: custom measure bypasses _filtered CTE, queries source directly', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
      limitRows: 1,
    })
    // With custom measure + limitRows, there is no _filtered CTE — grand total comes from source
    expect(result.sql).not.toContain('_filtered')
    expect(result.sql).toContain('_top_rows')
  })

  it('buildFlatModeSinglePass: grand total is correct when limitRows is set', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
      limitRows: 1,
    })
    const rows = await queryAll(conn, result.sql)
    // Grand total (grand total only sees the top-1 dept by revenue)
    // Top dept is Sales (revenue=6000). Grand total restricted to Sales: 43.33%
    const grandTotal = rows.find((r: any) => r._g_dept === 1)
    expect(grandTotal.margin_pct).toBeCloseTo(43.33, 1)
  })

  it('throws if custom measure has no expression', () => {
    const badSchema = makeSchema({
      dimensions: [{ id: 'dept', sourceField: 'dept' }],
      measures: [{ id: 'bad', sourceField: 'revenue', aggregation: 'custom' }],
    })
    const qb = new QueryBuilder(badSchema)
    expect(() => qb.buildAggregation({ dimensions: [], values: [{ field: 'bad', aggregation: 'custom' }] }))
      .toThrow('Custom measure "bad" requires a valid expression field')
  })
})

// ═════════════════════════════════════════════════════════════════════
// Custom aggregate measures — contract tests
//
// The base suite above covers: custom alone, custom + sum (one case),
// basic grand total correctness, limitRows (one case), error on missing
// expression.
//
// These suites cover the full behavioral contract:
//
//   B. Adding a custom measure does NOT change the values of other
//      measures in the same query (isolation guarantee).
//
//   C. Custom measures produce correct values with column dimensions
//      (cross-tab), including per-cell, row subtotals, and grand total.
//
//   D. limitCols restricts column dimension values correctly when custom
//      measures are present.
//
//   E. User filters (activeFilters) are applied correctly to custom
//      measures in both single-pass and flat-mode paths.
//
//   F. Multiple custom measures in the same query each compute
//      independently and do not interfere with each other.
//
//   G. Multi-level row ROLLUP produces correct intermediate subtotals
//      (not just the grand total).
// ═════════════════════════════════════════════════════════════════════

// ── B. Isolation ──────────────────────────────────────────────────────

describe('custom measures: other measures in the same query are unaffected', () => {
  // Dataset: 2 departments × 3 rows each
  //   dept  | revenue | cost
  //   Sales | 1000    | 600
  //   Sales | 2000    | 1000
  //   Sales | 3000    | 1800
  //   Ops   | 500     | 200
  //   Ops   | 1500    | 900
  //   Ops   | 2000    | 1200
  //
  // Baseline values by measure type:
  //   revenue SUM:   Sales=6000,    Ops=4000,    Total=10000
  //   revenue AVG:   Sales=2000,    Ops=1333.33, Total=1666.67
  //   revenue COUNT: Sales=3,       Ops=3,       Total=6

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 1000, 600), ('Sales', 2000, 1000), ('Sales', 3000, 1800),
        ('Ops',    500, 200), ('Ops',   1500,  900), ('Ops',   2000, 1200);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [{ id: 'dept', sourceField: 'dept' }],
    measures: [
      { id: 'revenue',     sourceField: 'revenue', aggregation: 'sum' },
      { id: 'avg_revenue', sourceField: 'revenue', aggregation: 'avg' },
      { id: 'count_txns',  sourceField: 'revenue', aggregation: 'count' },
      { id: 'margin_pct',  sourceField: 'revenue', aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  // Helper: compare every row (detail + subtotals) of two result sets
  async function compareAllRows(
    qb: QueryBuilder,
    measureIds: string[],
    measureIdsWithCustom: string[],
    checkField: string
  ) {
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: measureIds,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: measureIdsWithCustom,
    }).sql)
    for (const row of alone) {
      const match = findRow(mixed, { dept: row._g_dept === 1 ? null : row.dept })
      expect(match[checkField]).toBeCloseTo(row[checkField], 5)
    }
  }

  async function compareAllRowsFlat(
    qb: QueryBuilder,
    measureIds: string[],
    measureIdsWithCustom: string[],
    checkField: string
  ) {
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: measureIds, limitRows: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: measureIdsWithCustom, limitRows: 10,
    }).sql)
    for (const row of rollupRows(alone)) {
      const match = findRow(rollupRows(mixed), { dept: row._g_dept === 1 ? null : row.dept })
      expect(match[checkField]).toBeCloseTo(row[checkField], 5)
    }
  }

  it('sum: values are identical at every rollup level with or without custom', async () => {
    const qb = new QueryBuilder(schema)
    await compareAllRows(qb, ['revenue'], ['revenue', 'margin_pct'], 'revenue')
  })

  it('avg: values are identical at every rollup level with or without custom', async () => {
    const qb = new QueryBuilder(schema)
    await compareAllRows(qb, ['avg_revenue'], ['avg_revenue', 'margin_pct'], 'avg_revenue')
  })

  it('count: values are identical at every rollup level with or without custom', async () => {
    const qb = new QueryBuilder(schema)
    await compareAllRows(qb, ['count_txns'], ['count_txns', 'margin_pct'], 'count_txns')
  })

  it('sum + avg together: both are unaffected by adding custom to the same query', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue', 'avg_revenue'],
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue', 'avg_revenue', 'margin_pct'],
    }).sql)
    for (const row of alone) {
      const match = findRow(mixed, { dept: row._g_dept === 1 ? null : row.dept })
      expect(match.revenue).toBeCloseTo(row.revenue, 5)
      expect(match.avg_revenue).toBeCloseTo(row.avg_revenue, 5)
    }
  })

  it('sum (flat mode): values identical with or without custom when limitRows is set', async () => {
    const qb = new QueryBuilder(schema)
    await compareAllRowsFlat(qb, ['revenue'], ['revenue', 'margin_pct'], 'revenue')
  })

  it('avg (flat mode): values identical with or without custom when limitRows is set', async () => {
    const qb = new QueryBuilder(schema)
    await compareAllRowsFlat(qb, ['avg_revenue'], ['avg_revenue', 'margin_pct'], 'avg_revenue')
  })
})

// ── C + D. Column dimensions (cross-tab) and limitCols ────────────────

describe('custom measures: column dimensions (cross-tab)', () => {
  // Dataset: 2 departments × 2 years, one row per cell
  //   dept  | year | revenue | cost
  //   Sales | 2024 | 4000    | 2200   margin = (4000-2200)/4000*100 = 45%
  //   Sales | 2025 | 2000    | 1800   margin = (2000-1800)/2000*100 = 10%
  //   Ops   | 2024 | 3000    | 1500   margin = (3000-1500)/3000*100 = 50%
  //   Ops   | 2025 | 1000    | 700    margin = (1000-700)/1000*100  = 30%
  //
  // Subtotals:
  //   Sales total: (6000-4000)/6000*100   = 33.33%
  //   Ops total:   (4000-2200)/4000*100   = 45%
  //   2024 total:  (7000-3700)/7000*100   = 47.14%
  //   2025 total:  (3000-2500)/3000*100   = 16.67%
  //   Grand total: (10000-6200)/10000*100 = 38%

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, year INTEGER, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 2024, 4000, 2200),
        ('Sales', 2025, 2000, 1800),
        ('Ops',   2024, 3000, 1500),
        ('Ops',   2025, 1000, 700);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'dept', sourceField: 'dept' },
      { id: 'year', sourceField: 'year' },
    ],
    measures: [
      { id: 'revenue',    sourceField: 'revenue', aggregation: 'sum' },
      { id: 'margin_pct', sourceField: 'revenue', aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  it('per-cell margin is correct for each dept × year combination', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'], measures: ['margin_pct'],
    }).sql)

    expect(findRow(rows, { dept: 'Sales', year: 2024 }).margin_pct).toBeCloseTo(45,    1)
    expect(findRow(rows, { dept: 'Sales', year: 2025 }).margin_pct).toBeCloseTo(10,    1)
    expect(findRow(rows, { dept: 'Ops',   year: 2024 }).margin_pct).toBeCloseTo(50,    1)
    expect(findRow(rows, { dept: 'Ops',   year: 2025 }).margin_pct).toBeCloseTo(30,    1)
  })

  it('row subtotals (dept total across all years) are correct', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'], measures: ['margin_pct'],
    }).sql)

    // year=null means year is rolled up — this is the dept row total
    expect(findRow(rows, { dept: 'Sales', year: null }).margin_pct).toBeCloseTo(33.33, 1)
    expect(findRow(rows, { dept: 'Ops',   year: null }).margin_pct).toBeCloseTo(45,    1)
  })

  it('grand total is population-level margin across all depts and years', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'], measures: ['margin_pct'],
    }).sql)

    expect(findRow(rows, { dept: null, year: null }).margin_pct).toBeCloseTo(38, 1)
  })

  it('sum measure is unaffected at every cell when custom is in the same cross-tab query', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'], measures: ['revenue'],
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'], measures: ['revenue', 'margin_pct'],
    }).sql)

    for (const row of alone) {
      const deptVal = row._g_dept === 1 ? null : row.dept
      const yearVal = row._g_year === 1 ? null : row.year
      const match = findRow(mixed, { dept: deptVal, year: yearVal })
      expect(match.revenue).toBeCloseTo(row.revenue, 5)
    }
  })

  it('limitCols: restricts to top-N column values when custom measure is present', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'],
      measures: ['margin_pct'], limitCols: 1,
    })
    const rows = await queryAll(conn, result.sql)

    // limitCols orders by the first measure (margin_pct); 2024 has higher margin (47.1% vs 16.7%)
    const detailYears = rollupRows(rows)
      .filter((r: any) => r._g_year === 0)
      .map((r: any) => r.year)
    const uniqueYears = [...new Set(detailYears)]
    expect(uniqueYears).toHaveLength(1)
    expect(uniqueYears[0]).toBe(2024)
  })

  it('limitCols: sum measure value is unchanged with or without custom', async () => {
    const qb = new QueryBuilder(schema)
    // limitCols=2 includes both years, tests flat-mode code path
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'],
      measures: ['revenue'], limitCols: 2,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], columnDimensions: ['year'],
      measures: ['revenue', 'margin_pct'], limitCols: 2,
    }).sql)

    for (const row of rollupRows(alone)) {
      const deptVal = row._g_dept === 1 ? null : row.dept
      const yearVal = row._g_year === 1 ? null : row.year
      const match = findRow(rollupRows(mixed), { dept: deptVal, year: yearVal })
      expect(match.revenue).toBeCloseTo(row.revenue, 5)
    }
  })
})

// ── E. User filters ───────────────────────────────────────────────────

describe('custom measures: user filters', () => {
  // Dataset: dept/revenue/cost (same shape as base custom measures tests)
  //   Sales total: revenue=6000, cost=3400, margin=43.33%
  //   Ops total:   revenue=4000, cost=2300, margin=42.5%

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 1000, 600), ('Sales', 2000, 1000), ('Sales', 3000, 1800),
        ('Ops',    500, 200), ('Ops',   1500,  900), ('Ops',   2000, 1200);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [{ id: 'dept', sourceField: 'dept' }],
    measures: [
      { id: 'revenue',    sourceField: 'revenue', aggregation: 'sum' },
      { id: 'margin_pct', sourceField: 'revenue', aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  it('equality filter restricts custom measure to matching rows only', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
      filters: [{ field: 'dept', operator: '=', value: 'Sales' }],
    }).sql)
    // Only Sales rows visible: grand total = Sales margin = 43.33%
    expect(findRow(rows, { dept: null }).margin_pct).toBeCloseTo(43.33, 1)
    // Ops dept row should not appear
    expect(rows.filter((r: any) => r.dept === 'Ops' && r._g_dept === 0)).toHaveLength(0)
  })

  it('in-list filter restricts to listed values', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['revenue', 'margin_pct'],
      filters: [{ field: 'dept', operator: 'in', value: ['Sales'] }],
    }).sql)
    const salesRow = findRow(rows, { dept: 'Sales' })
    expect(salesRow.revenue).toBeCloseTo(6000)
    expect(salesRow.margin_pct).toBeCloseTo(43.33, 1)
    expect(findRow(rows, { dept: null }).margin_pct).toBeCloseTo(43.33, 1)
  })

  it('filter with limitRows (flat mode): custom measure is still restricted to filtered rows', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      measures: ['margin_pct'],
      filters: [{ field: 'dept', operator: '=', value: 'Sales' }],
      limitRows: 10,
    }).sql)
    expect(findRow(rollupRows(rows), { dept: null }).margin_pct).toBeCloseTo(43.33, 1)
  })

  it('filter does not affect a non-custom measure differently than without custom', async () => {
    const qb = new QueryBuilder(schema)
    const filter = [{ field: 'dept', operator: '=', value: 'Sales' }] as const
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue'], filters: filter,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue', 'margin_pct'], filters: filter,
    }).sql)
    expect(findRow(alone, { dept: 'Sales' }).revenue)
      .toBeCloseTo(findRow(mixed, { dept: 'Sales' }).revenue, 5)
    expect(findRow(alone, { dept: null }).revenue)
      .toBeCloseTo(findRow(mixed, { dept: null }).revenue, 5)
  })
})

// ── F. Multiple custom measures ───────────────────────────────────────

describe('custom measures: multiple custom measures in the same query', () => {
  // Dataset: dept/revenue/cost
  // Two custom measures with a mathematical identity:
  //   margin_pct  = (revenue - cost) / revenue * 100
  //   cost_ratio  = cost / revenue * 100
  //   margin_pct + cost_ratio = 100 (at every level, including subtotals)
  //
  // Grand total: revenue=10000, cost=5700
  //   margin_pct = 43%, cost_ratio = 57%

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 1000, 600), ('Sales', 2000, 1000), ('Sales', 3000, 1800),
        ('Ops',    500, 200), ('Ops',   1500,  900), ('Ops',   2000, 1200);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [{ id: 'dept', sourceField: 'dept' }],
    measures: [
      { id: 'revenue',    sourceField: 'revenue', aggregation: 'sum' },
      { id: 'margin_pct', sourceField: 'revenue', aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
      { id: 'cost_ratio', sourceField: 'cost',    aggregation: 'custom',
        expression: 'SUM("cost") / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  it('both custom measures appear in every result row', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['margin_pct', 'cost_ratio'],
    }).sql)
    for (const row of rows) {
      expect(row).toHaveProperty('margin_pct')
      expect(row).toHaveProperty('cost_ratio')
    }
  })

  it('each custom measure has the correct value per group', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['margin_pct', 'cost_ratio'],
    }).sql)
    // Sales: revenue=6000, cost=3400
    expect(findRow(rows, { dept: 'Sales' }).margin_pct).toBeCloseTo(43.33, 1)
    expect(findRow(rows, { dept: 'Sales' }).cost_ratio).toBeCloseTo(56.67, 1)
    // Ops: revenue=4000, cost=2300
    expect(findRow(rows, { dept: 'Ops' }).margin_pct).toBeCloseTo(42.5,  1)
    expect(findRow(rows, { dept: 'Ops' }).cost_ratio).toBeCloseTo(57.5,  1)
  })

  it('each custom measure has the correct grand total', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['margin_pct', 'cost_ratio'],
    }).sql)
    // Total: revenue=10000, cost=5700
    expect(findRow(rows, { dept: null }).margin_pct).toBeCloseTo(43, 1)
    expect(findRow(rows, { dept: null }).cost_ratio).toBeCloseTo(57, 1)
  })

  it('margin_pct + cost_ratio = 100 at every rollup level (mathematical identity)', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['margin_pct', 'cost_ratio'],
    }).sql)
    for (const row of rows) {
      expect(row.margin_pct + row.cost_ratio).toBeCloseTo(100, 4)
    }
  })

  it('a non-custom measure is unaffected when two custom measures are present', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue'],
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['dept'], measures: ['revenue', 'margin_pct', 'cost_ratio'],
    }).sql)
    for (const row of alone) {
      const deptVal = row._g_dept === 1 ? null : row.dept
      expect(findRow(mixed, { dept: deptVal }).revenue).toBeCloseTo(row.revenue, 5)
    }
  })
})

// ── G. Multi-level row ROLLUP ─────────────────────────────────────────

describe('custom measures: multi-level row ROLLUP', () => {
  // Dataset: 2 regions × 2 depts, one row per combination
  //   region | dept  | revenue | cost
  //   North  | Sales | 3000    | 1800   margin = (3000-1800)/3000*100 = 40%
  //   North  | Ops   | 2000    | 1000   margin = (2000-1000)/2000*100 = 50%
  //   South  | Sales | 3000    | 1600   margin = (3000-1600)/3000*100 = 46.67%
  //   South  | Ops   | 2000    | 1300   margin = (2000-1300)/2000*100 = 35%
  //
  // Intermediate subtotals (region level):
  //   North: revenue=5000, cost=2800, margin=(5000-2800)/5000*100 = 44%
  //   South: revenue=5000, cost=2900, margin=(5000-2900)/5000*100 = 42%
  //
  // Grand total: revenue=10000, cost=5700, margin=43%

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (region VARCHAR, dept VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES
        ('North', 'Sales', 3000, 1800),
        ('North', 'Ops',   2000, 1000),
        ('South', 'Sales', 3000, 1600),
        ('South', 'Ops',   2000, 1300);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'dept',   sourceField: 'dept' },
    ],
    measures: [
      { id: 'revenue',    sourceField: 'revenue', aggregation: 'sum' },
      { id: 'margin_pct', sourceField: 'revenue', aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  it('per-leaf margin is correct for each region × dept combination', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'dept'], measures: ['margin_pct'],
    }).sql)

    expect(findRow(rows, { region: 'North', dept: 'Sales' }).margin_pct).toBeCloseTo(40,    1)
    expect(findRow(rows, { region: 'North', dept: 'Ops'   }).margin_pct).toBeCloseTo(50,    1)
    expect(findRow(rows, { region: 'South', dept: 'Sales' }).margin_pct).toBeCloseTo(46.67, 1)
    expect(findRow(rows, { region: 'South', dept: 'Ops'   }).margin_pct).toBeCloseTo(35,    1)
  })

  it('intermediate region subtotals are population-level (not average of dept values)', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'dept'], measures: ['margin_pct'],
    }).sql)

    // dept=null means dept is rolled up — this is the region subtotal row
    expect(findRow(rows, { region: 'North', dept: null }).margin_pct).toBeCloseTo(44, 1)
    expect(findRow(rows, { region: 'South', dept: null }).margin_pct).toBeCloseTo(42, 1)

    // Sanity check: if subtotals were average-of-rows they would be
    // North=(40+50)/2=45, South=(46.67+35)/2=40.83 — both wrong
  })

  it('grand total is population-level across all regions and depts', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'dept'], measures: ['margin_pct'],
    }).sql)

    expect(findRow(rows, { region: null, dept: null }).margin_pct).toBeCloseTo(43, 1)
  })

  it('sum measure is unaffected at every rollup level when custom is present', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'dept'], measures: ['revenue'],
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'dept'], measures: ['revenue', 'margin_pct'],
    }).sql)

    for (const row of alone) {
      const regionVal = row._g_region === 1 ? null : row.region
      const deptVal   = row._g_dept   === 1 ? null : row.dept
      expect(findRow(mixed, { region: regionVal, dept: deptVal }).revenue)
        .toBeCloseTo(row.revenue, 5)
    }
  })
})

// ═════════════════════════════════════════════════════════════════════
// Custom measures + stock measures (flat-mode split+join path)
//
// When custom measures appear alongside eop or weighted_avg stock measures
// in a flat-mode query (limitRows/limitCols), the query builder splits them:
// non-custom measures go through _filtered → _flow (existing tested path),
// custom measures go through a direct _custom ROLLUP on source, and the
// two are joined at the end.
//
// This suite verifies that:
//   H. Custom + weighted_avg: custom measure is correct at every level,
//      weighted_avg is correct at every level, neither affects the other.
//   I. Custom + eop: same contract for eop.
//   J. Custom + weighted_avg + eop together in one query.
//   K. Flat-mode limiting (limitRows) with custom + stock.
// ═════════════════════════════════════════════════════════════════════

// Dataset: 2 regions × 2 countries × 3 months
//   Same data as the main stock suite at the top of this file.
//   revenue is a flow measure; inventory is stock weighted_avg; balance is stock eop.
//   margin_pct is a custom measure: (revenue - cost) / revenue * 100.
//
// Per-country expected values (from the base stock suite):
//   AU: revenue=600, inventory=50 (avg), balance=1200 (March)
//   JP: revenue=1500, inventory=80 (avg), balance=2400 (March)
//   UK: revenue=60,  inventory=30 (avg), balance=700  (March)
//   DE: revenue=150, inventory=100 (avg), balance=3500 (March)
//
// Cost column is added so margin_pct = (revenue-cost)/revenue*100 has known values.
// To keep the test self-contained, a fresh dataset is created.

describe('custom measures + stock measures (split+join path)', () => {
  // Dataset designed so margin_pct has easy exact values.
  // revenue = 2×cost for all rows → margin = 50% at every level.
  //
  // region | country | month      | revenue | cost | inventory | balance
  // APAC   | AU      | 2025-01-01 | 100     | 50   | 50        | 1000
  // APAC   | AU      | 2025-02-01 | 200     | 100  | 60        | 1100
  // APAC   | AU      | 2025-03-01 | 300     | 150  | 40        | 1200
  // APAC   | JP      | 2025-01-01 | 400     | 200  | 80        | 2000
  // APAC   | JP      | 2025-02-01 | 500     | 250  | 70        | 2200
  // APAC   | JP      | 2025-03-01 | 600     | 300  | 90        | 2400
  //
  // margin_pct at every level = 50% (revenue = 2 * cost always).
  // inventory weighted_avg: AU=(50+60+40)/3=50, JP=(80+70+90)/3=80.
  // eop balance: AU=1200 (March), JP=2400 (March).

  let db: any, conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE stock_custom (
        region VARCHAR, country VARCHAR, month DATE,
        revenue DOUBLE, cost DOUBLE, inventory DOUBLE, balance DOUBLE
      );
      INSERT INTO stock_custom VALUES
        ('APAC', 'AU', DATE '2025-01-01', 100, 50,  50, 1000),
        ('APAC', 'AU', DATE '2025-02-01', 200, 100, 60, 1100),
        ('APAC', 'AU', DATE '2025-03-01', 300, 150, 40, 1200),
        ('APAC', 'JP', DATE '2025-01-01', 400, 200, 80, 2000),
        ('APAC', 'JP', DATE '2025-02-01', 500, 250, 70, 2200),
        ('APAC', 'JP', DATE '2025-03-01', 600, 300, 90, 2400);
    `)
  })

  afterAll(() => { db?.close() })

  // No timeDimensions configured: stock measures (weighted_avg/eop) route through
  // buildSinglePassRollup → buildFlatModeSinglePass (with limitRows), exercising
  // the new split+join path. Without a time dimension context, stock measures are
  // treated as plain SUM in _filtered — the split ensures custom measures still get
  // their own direct-ROLLUP CTE (_custom) and are joined at the end.
  const schema = makeSchema({
    dimensions: [
      { id: 'region',  sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
    ],
    measures: [
      { id: 'revenue',    sourceField: 'revenue',   aggregation: 'sum' },
      { id: 'inventory',  sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
      { id: 'balance',    sourceField: 'balance',   aggregation: 'sum', timeAggregation: 'eop' },
      { id: 'margin_pct', sourceField: 'revenue',   aggregation: 'custom',
        expression: '(SUM("revenue") - SUM("cost")) / NULLIF(SUM("revenue"), 0) * 100' },
    ],
  })

  // ── H. Custom + weighted_avg ─────────────────────────────────────────

  it('H: custom measure is correct at leaf, subtotal, and grand total when weighted_avg is present', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    // Custom: revenue = 2×cost at every level → 50% everywhere
    expect(findRow(rollupRows(rows), { region: 'APAC', country: 'AU' }).margin_pct).toBeCloseTo(50, 1)
    expect(findRow(rollupRows(rows), { region: 'APAC', country: 'JP' }).margin_pct).toBeCloseTo(50, 1)
    expect(findRow(rollupRows(rows), { region: 'APAC', country: null }).margin_pct).toBeCloseTo(50, 1)
    expect(findRow(rollupRows(rows), { region: null, country: null }).margin_pct).toBeCloseTo(50, 1)
  })

  it('H: weighted_avg is correct at every level and matches standalone query', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    for (const row of rollupRows(alone)) {
      const regionVal  = row._g_region  === 1 ? null : row.region
      const countryVal = row._g_country === 1 ? null : row.country
      expect(findRow(rollupRows(mixed), { region: regionVal, country: countryVal }).inventory)
        .toBeCloseTo(row.inventory, 5)
    }
  })

  // ── I. Custom + eop ──────────────────────────────────────────────────

  it('I: custom measure is correct at every level when eop is present', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['balance', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    expect(findRow(rollupRows(rows), { region: 'APAC', country: 'AU' }).margin_pct).toBeCloseTo(50, 1)
    expect(findRow(rollupRows(rows), { region: 'APAC', country: null }).margin_pct).toBeCloseTo(50, 1)
    expect(findRow(rollupRows(rows), { region: null, country: null }).margin_pct).toBeCloseTo(50, 1)
  })

  it('I: eop is correct at every level and matches standalone query when custom is present', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['balance'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['balance', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    for (const row of rollupRows(alone)) {
      const regionVal  = row._g_region  === 1 ? null : row.region
      const countryVal = row._g_country === 1 ? null : row.country
      expect(findRow(rollupRows(mixed), { region: regionVal, country: countryVal }).balance)
        .toBeCloseTo(row.balance, 5)
    }
  })

  // ── J. Custom + weighted_avg + eop together ──────────────────────────

  it('J: all three measure types correct in the same query', async () => {
    // Without timeDimensions, stock measures are plain SUM in the _filtered path.
    // AU: inventory=50+60+40=150, balance=1000+1100+1200=3300; APAC: 150+240=390, 3300+6600=9900
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory', 'balance', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    const au = findRow(rollupRows(rows), { region: 'APAC', country: 'AU' })
    expect(au.inventory).toBeCloseTo(150,  0)   // SUM: 50+60+40
    expect(au.balance).toBeCloseTo(3300,   0)   // SUM: 1000+1100+1200
    expect(au.margin_pct).toBeCloseTo(50,  1)   // custom: 50%

    const apac = findRow(rollupRows(rows), { region: 'APAC', country: null })
    expect(apac.inventory).toBeCloseTo(390, 0)  // SUM: 150+240
    expect(apac.balance).toBeCloseTo(9900,  0)  // SUM: 3300+6600
    expect(apac.margin_pct).toBeCloseTo(50, 1)  // custom: still 50%

    const total = findRow(rollupRows(rows), { region: null, country: null })
    expect(total.inventory).toBeCloseTo(390, 0)
    expect(total.balance).toBeCloseTo(9900,  0)
    expect(total.margin_pct).toBeCloseTo(50, 1)
  })

  it('J: non-custom flow measure is also unaffected', async () => {
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue', 'inventory', 'balance', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 10,
    }).sql)

    for (const row of rollupRows(alone)) {
      const regionVal  = row._g_region  === 1 ? null : row.region
      const countryVal = row._g_country === 1 ? null : row.country
      expect(findRow(rollupRows(mixed), { region: regionVal, country: countryVal }).revenue)
        .toBeCloseTo(row.revenue, 5)
    }
  })

  // ── K. Flat-mode limiting + cross-tab ───────────────────────────────

  it('K: limitCols with cross-tab — _join covers GROUPING SETS column dims', async () => {
    // columnDimensions triggers GROUPING SETS in the ROLLUP clause instead of plain ROLLUP.
    // Both _flow and _custom use the same structure, so the IS NOT DISTINCT FROM join
    // correctly matches column-subtotal and grand-total rows from both sides.
    const qb = new QueryBuilder(schema)
    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['country'],
      columnDimensions: ['region'],
      measures: ['revenue'],
      source: 'stock_custom',
      limitCols: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['country'],
      columnDimensions: ['region'],
      measures: ['revenue', 'margin_pct'],
      source: 'stock_custom',
      limitCols: 10,
    }).sql)

    // Revenue is identical at every rollup level in the mixed query
    for (const row of rollupRows(alone)) {
      const countryVal = row._g_country === 1 ? null : row.country
      const regionVal  = row._g_region  === 1 ? null : row.region
      expect(findRow(rollupRows(mixed), { country: countryVal, region: regionVal }).revenue)
        .toBeCloseTo(row.revenue, 5)
    }
  })

  it('K: cross-tab custom measure is 50% at every cell, row subtotal, and grand total', async () => {
    // margin_pct = 50% everywhere because revenue = 2×cost in every row.
    // Exercises the _join path with GROUPING SETS (column dims) at all rollup levels.
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['country'],
      columnDimensions: ['region'],
      measures: ['revenue', 'margin_pct'],
      source: 'stock_custom',
      limitCols: 10,
    }).sql)

    for (const row of rollupRows(rows)) {
      expect(row.margin_pct).toBeCloseTo(50, 1)
    }
  })

  it('K: user filter applied to both _flow and _custom — results consistent', async () => {
    // With an active filter, allFilters propagates into both _filtered (for _flow)
    // and _custom's WHERE clause, keeping their row sets in sync.
    const qb = new QueryBuilder(schema)
    const filter = [{ field: 'region', operator: '=' as const, value: 'APAC' }]

    const alone = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue'],
      source: 'stock_custom',
      filters: filter,
      limitRows: 10,
    }).sql)
    const mixed = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue', 'margin_pct'],
      source: 'stock_custom',
      filters: filter,
      limitRows: 10,
    }).sql)

    // Revenue is unaffected by the presence of custom
    for (const row of rollupRows(alone)) {
      const regionVal  = row._g_region  === 1 ? null : row.region
      const countryVal = row._g_country === 1 ? null : row.country
      expect(findRow(rollupRows(mixed), { region: regionVal, country: countryVal }).revenue)
        .toBeCloseTo(row.revenue, 5)
    }
    // Custom measure is 50% everywhere (only APAC rows visible, but still revenue = 2×cost)
    for (const row of rollupRows(mixed)) {
      expect(row.margin_pct).toBeCloseTo(50, 1)
    }
    // EMEA is filtered out — only APAC rows should appear
    expect(rollupRows(mixed).filter((r: any) => r._g_region === 0 && r.region !== 'APAC')).toHaveLength(0)
  })

  it('K: limitRows restricts results but custom and stock values remain correct', async () => {
    const qb = new QueryBuilder(schema)
    const rows = await queryAll(conn, qb.buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['inventory', 'balance', 'margin_pct'],
      source: 'stock_custom',
      limitRows: 1,   // only top-1 country by inventory (SUM, highest = JP at 240)
    }).sql)

    // With limitRows=1 the top-N country is restricted; values for included rows are still correct
    const detail = rollupRows(rows).filter((r: any) => r._g_country === 0)
    expect(detail).toHaveLength(1)
    expect(detail[0].margin_pct).toBeCloseTo(50, 1)
    // The single country's stock values are unchanged (plain SUM without timeDimensions)
    const country = detail[0].country
    if (country === 'AU') {
      expect(detail[0].inventory).toBeCloseTo(150, 0)  // SUM: 50+60+40
      expect(detail[0].balance).toBeCloseTo(3300,  0)  // SUM: 1000+1100+1200
    } else {
      expect(detail[0].inventory).toBeCloseTo(240, 0)  // SUM: 80+70+90
      expect(detail[0].balance).toBeCloseTo(6600,  0)  // SUM: 2000+2200+2400
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// Derived measures (comparison formulas)
// ══════════════════════════════════════════════════════════════════════════════
//
// Dataset: dept × year, one row per combination.
//
//   dept  | year | revenue
//   Sales | 2022 | 1000
//   Sales | 2023 | 1200
//   Sales | 2024 | 1500
//   Ops   | 2022 |  500
//   Ops   | 2023 |  600
//   Ops   | 2024 |  750
//
// Hand-computed YoY% (revenue[year] / revenue[year-1] - 1):
//   Sales 2023: (1200-1000)/1000 = 0.20  (20%)
//   Sales 2024: (1500-1200)/1200 = 0.25  (25%)
//   Ops   2023: (600-500)/500   = 0.20  (20%)
//   Ops   2024: (750-600)/600   = 0.25  (25%)
//   Subtotals (dept=null or year=null): NULL — comparison across rows not defined
//
// Revenue totals: Sales=3700, Ops=1850, Grand=5550

describe('derived measures (comparison formulas)', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (dept VARCHAR, year INTEGER, revenue DOUBLE);
      INSERT INTO data VALUES
        ('Sales', 2022, 1000),
        ('Sales', 2023, 1200),
        ('Sales', 2024, 1500),
        ('Ops',   2022,  500),
        ('Ops',   2023,  600),
        ('Ops',   2024,  750);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'dept', sourceField: 'dept' },
      { id: 'year', sourceField: 'year' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      {
        id: 'yoy_pct',
        sourceField: 'revenue',
        derivedExpression:
          'revenue / LAG(revenue) OVER (PARTITION BY dept ORDER BY year) - 1',
        dependsOn: ['revenue'],
      },
    ],
  })

  it('SQL uses _base and _derived CTEs with LEFT JOIN', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
    })
    expect(result.sql).toContain('_base')
    expect(result.sql).toContain('_derived')
    expect(result.sql).toContain('LEFT JOIN')
    expect(result.sql).toContain('LAG')
    expect(result.sql).toContain('IS NOT DISTINCT FROM')
  })

  it('derivedMeasureFields is set in result', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
    })
    expect(result.derivedMeasureFields).toEqual(['yoy_pct'])
    expect(result.measureFields).toContain('yoy_pct')
    expect(result.measureFields).toContain('revenue')
  })

  it('leaf rows have correct YoY% values', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
    })
    const rows = await queryAll(conn, result.sql)

    // First year per dept: no prior → NULL
    expect(findRow(rows, { dept: 'Sales', year: 2022 }).yoy_pct).toBeNull()
    expect(findRow(rows, { dept: 'Ops',   year: 2022 }).yoy_pct).toBeNull()

    // Subsequent years: correct YoY%
    expect(findRow(rows, { dept: 'Sales', year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { dept: 'Sales', year: 2024 }).yoy_pct).toBeCloseTo(0.25, 4)
    expect(findRow(rows, { dept: 'Ops',   year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { dept: 'Ops',   year: 2024 }).yoy_pct).toBeCloseTo(0.25, 4)
  })

  it('subtotal and grand-total rows have NULL for derived measure', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
    })
    const rows = await queryAll(conn, result.sql)

    // dept subtotals (year rolled up)
    expect(findRow(rows, { dept: 'Sales', year: null }).yoy_pct).toBeNull()
    expect(findRow(rows, { dept: 'Ops',   year: null }).yoy_pct).toBeNull()
    // grand total
    expect(findRow(rows, { dept: null, year: null }).yoy_pct).toBeNull()
  })

  it('base measures are still correct alongside derived measures', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
    })
    const rows = await queryAll(conn, result.sql)

    expect(findRow(rows, { dept: 'Sales', year: 2022 }).revenue).toBeCloseTo(1000)
    expect(findRow(rows, { dept: 'Sales', year: null }).revenue).toBeCloseTo(3700)  // 1000+1200+1500
    expect(findRow(rows, { dept: null,    year: null }).revenue).toBeCloseTo(5550)  // 3700+500+600+750
  })

  it('wrapWithPercentages does not add a pct column for derived measure', () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],
      displayMode: 'pct_total',
    })
    // revenue_pct should exist; yoy_pct_pct should NOT
    expect(result.percentageFields).toContain('revenue_pct')
    expect(result.percentageFields).not.toContain('yoy_pct_pct')
    expect(result.sql).not.toContain('yoy_pct_pct')
  })

  it('buildAggregation with derived measure outputs NULL (no row context)', async () => {
    const qb = new QueryBuilder(schema)
    const result = qb.buildAggregation({
      dimensions: ['dept'],
      values: [{ field: 'revenue', aggregation: 'sum' }, { field: 'yoy_pct', aggregation: 'sum' }],
    })
    expect(result.sql).toContain('NULL')
    const rows = await queryAll(conn, result.sql)
    for (const row of rows) {
      expect(row.yoy_pct).toBeNull()
    }
  })

  it('declared dependsOn measure is auto-included even when not explicitly selected', async () => {
    // yoy_pct declares dependsOn: ['revenue']. When only yoy_pct is selected,
    // the engine auto-adds revenue to _base so the expression can reference it.
    const schemaWithDeps = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_pct',
          sourceField: 'revenue',
          derivedExpression: 'revenue / LAG(revenue) OVER (PARTITION BY dept ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })
    const qb = new QueryBuilder(schemaWithDeps)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['yoy_pct'],  // revenue not explicitly requested
    })
    // revenue should be auto-included in measureFields (auto-dep)
    expect(result.measureFields).toContain('revenue')
    expect(result.measureFields).toContain('yoy_pct')

    // SQL should work and produce correct values
    const rows = await queryAll(conn, result.sql)
    expect(findRow(rows, { dept: 'Sales', year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { dept: 'Sales', year: null }).yoy_pct).toBeNull()
  })

  it('declared dependsOn with explicit selection: no duplicate columns', async () => {
    // When revenue is both in dependsOn and explicitly selected, no duplicate columns
    const schemaWithDeps = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_pct',
          sourceField: 'revenue',
          derivedExpression: 'revenue / LAG(revenue) OVER (PARTITION BY dept ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })
    const qb = new QueryBuilder(schemaWithDeps)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct'],  // revenue explicitly selected AND in dependsOn
    })
    // revenue should appear exactly once in measureFields
    const revenueCount = result.measureFields.filter(f => f === 'revenue').length
    expect(revenueCount).toBe(1)

    const rows = await queryAll(conn, result.sql)
    expect(findRow(rows, { dept: 'Sales', year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { dept: 'Sales', year: 2023 }).revenue).toBeCloseTo(1200)
  })

  it('two-pass path (stock measure) + derived measure', async () => {
    // Stock measures trigger buildTwoPassRollup. Verify that derived measures
    // still work correctly when wrapped around two-pass output.
    //
    // Dataset: region × month, with a stock measure (inventory, weighted_avg)
    // and a flow measure (revenue, sum). Derived measure computes month-over-month
    // revenue change.
    //
    // Revenue per region per month:
    //   East 2025-01: 100, East 2025-02: 150, East 2025-03: 200
    //   West 2025-01: 300, West 2025-02: 360, West 2025-03: 450
    //
    // MoM% = revenue / LAG(revenue) - 1:
    //   East 2025-02: 150/100 - 1 = 0.50
    //   East 2025-03: 200/150 - 1 ≈ 0.3333
    //   West 2025-02: 360/300 - 1 = 0.20
    //   West 2025-03: 450/360 - 1 = 0.25

    const db2 = new duckdb.Database(':memory:')
    const conn2 = db2.connect()
    await exec(conn2, `
      CREATE TABLE data (region VARCHAR, month DATE, revenue DOUBLE, inventory DOUBLE);
      INSERT INTO data VALUES
        ('East', DATE '2025-01-01', 100, 500),
        ('East', DATE '2025-02-01', 150, 520),
        ('East', DATE '2025-03-01', 200, 510),
        ('West', DATE '2025-01-01', 300, 800),
        ('West', DATE '2025-02-01', 360, 850),
        ('West', DATE '2025-03-01', 450, 900);
    `)

    const stockSchema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        { id: 'inventory', sourceField: 'inventory', aggregation: 'sum', timeAggregation: 'weighted_avg' },
        {
          id: 'mom_pct',
          sourceField: 'revenue',
          derivedExpression: 'revenue / LAG(revenue) OVER (PARTITION BY region ORDER BY month) - 1',
          dependsOn: ['revenue'],
        },
      ],
      timeDimensions: [
        { sourceColumn: 'month', granularity: 'month', stockWeighting: 'months' },
      ],
    })

    const qb = new QueryBuilder(stockSchema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['region', 'month'],
      measures: ['revenue', 'inventory', 'mom_pct'],
    })

    // Confirm two-pass path was used (stock measure presence)
    expect(result.sql).toContain('_base')
    expect(result.sql).toContain('_derived')
    expect(result.derivedMeasureFields).toEqual(['mom_pct'])

    const rows = await queryAll(conn2, result.sql)

    // Leaf rows: correct MoM%
    expect(findRow(rows, { region: 'East', month: '2025-02-01' }).mom_pct).toBeCloseTo(0.50, 4)
    expect(findRow(rows, { region: 'East', month: '2025-03-01' }).mom_pct).toBeCloseTo(0.3333, 3)
    expect(findRow(rows, { region: 'West', month: '2025-02-01' }).mom_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { region: 'West', month: '2025-03-01' }).mom_pct).toBeCloseTo(0.25, 4)

    // Subtotals: NULL for derived measure, valid for base measures
    expect(findRow(rows, { region: 'East', month: null }).mom_pct).toBeNull()
    expect(findRow(rows, { region: 'East', month: null }).revenue).toBeCloseTo(450)  // 100+150+200
    expect(findRow(rows, { region: null, month: null }).mom_pct).toBeNull()

    db2.close()
  })

  it('without PARTITION BY, derived SQL has no dept partitioning', () => {
    // Documents why $DIMS(x) is needed. Without it, the derived expression
    // has no PARTITION BY on dept, so LAG compares across groups.
    // We verify the generated SQL rather than query results to avoid
    // depending on nondeterministic row ordering.
    const badSchema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_bad',
          sourceField: 'revenue',
          // No PARTITION BY — will compare across depts!
          derivedExpression: 'revenue / LAG(revenue) OVER (ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })
    const qb = new QueryBuilder(badSchema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      columnDimensions: ['year'],
      measures: ['revenue', 'yoy_bad'],
    })

    // Grouping columns are always injected into OVER(), but without $DIMS(year)
    // there's no PARTITION BY "dept" — so the window spans all depts within a level.
    expect(result.sql).not.toContain('PARTITION BY "dept"')
    expect(result.sql).toContain('"_g_dept"')
  })

  it('$DIMS(x) produces correct partitioning across views', async () => {
    const dimsSchema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_pct_dims',
          sourceField: 'revenue',
          derivedExpression:
            'revenue / LAG(revenue) OVER (PARTITION BY $DIMS(year) ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })

    // View 1: dept on rows, year on columns
    const qb1 = new QueryBuilder(dimsSchema)
    const result1 = qb1.buildRollupAggregation({
      rowDimensions: ['dept'],
      columnDimensions: ['year'],
      measures: ['revenue', 'yoy_pct_dims'],
    })
    const rows1 = await queryAll(conn, result1.sql)

    // First year per dept: NULL
    expect(findRow(rows1, { dept: 'Sales', year: 2022 }).yoy_pct_dims).toBeNull()
    expect(findRow(rows1, { dept: 'Ops',   year: 2022 }).yoy_pct_dims).toBeNull()
    // Subsequent years: correct YoY
    expect(findRow(rows1, { dept: 'Sales', year: 2023 }).yoy_pct_dims).toBeCloseTo(0.20, 4)
    expect(findRow(rows1, { dept: 'Ops',   year: 2023 }).yoy_pct_dims).toBeCloseTo(0.20, 4)
    expect(findRow(rows1, { dept: 'Sales', year: 2024 }).yoy_pct_dims).toBeCloseTo(0.25, 4)

    // View 2: both dept and year on rows (same measure, different layout)
    const result2 = qb1.buildRollupAggregation({
      rowDimensions: ['dept', 'year'],
      measures: ['revenue', 'yoy_pct_dims'],
    })
    const rows2 = await queryAll(conn, result2.sql)

    expect(findRow(rows2, { dept: 'Sales', year: 2022 }).yoy_pct_dims).toBeNull()
    expect(findRow(rows2, { dept: 'Sales', year: 2023 }).yoy_pct_dims).toBeCloseTo(0.20, 4)
    expect(findRow(rows2, { dept: 'Ops',   year: 2024 }).yoy_pct_dims).toBeCloseTo(0.25, 4)
  })

  it('$DIMS(x) with single dimension (no partition needed)', async () => {
    const singleDimSchema = makeSchema({
      dimensions: [
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_single',
          sourceField: 'revenue',
          derivedExpression:
            'revenue / LAG(revenue) OVER (PARTITION BY $DIMS(year) ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })
    const qb = new QueryBuilder(singleDimSchema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['year'],
      measures: ['revenue', 'yoy_single'],
    })
    // $DIMS(year) expands to 1 (no other dims); grouping cols are also injected
    expect(result.sql).toContain('"_g_year", 1')

    const rows = await queryAll(conn, result.sql)
    // 2022: Sales 1000 + Ops 500 = 1500
    // 2023: 1200 + 600 = 1800 → YoY = 0.20
    expect(findRow(rows, { year: 2022 }).yoy_single).toBeNull()
    expect(findRow(rows, { year: 2023 }).yoy_single).toBeCloseTo(0.20, 4)
  })

  it('cross-tab: derived measures compute at column subtotals', async () => {
    // With rowDimensions: ['dept'], columnDimensions: ['year'], ROLLUP produces:
    //   Leaf:    _g_dept=0, _g_year=0  (dept, year)
    //   RowTot:  _g_dept=0, _g_year=1  (dept total, year rolled up)
    //   ColTot:  _g_dept=1, _g_year=0  (dept rolled up, year present)
    //   Grand:   _g_dept=1, _g_year=1  (both rolled up)
    //
    // ColTot rows have year values → YoY should compute (all depts combined per year).
    // RowTot and Grand: year is NULL → YoY should be NULL.
    //
    // Combined revenue per year: 2022=1500, 2023=1800, 2024=2250
    // ColTot YoY: 2022=NULL, 2023=(1800/1500)-1=0.20, 2024=(2250/1800)-1=0.25

    const dimsSchema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'year', sourceField: 'year' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'yoy_pct',
          sourceField: 'revenue',
          derivedExpression:
            'revenue / LAG(revenue) OVER (PARTITION BY $DIMS(year) ORDER BY year) - 1',
          dependsOn: ['revenue'],
        },
      ],
    })

    const qb = new QueryBuilder(dimsSchema)
    const result = qb.buildRollupAggregation({
      rowDimensions: ['dept'],
      columnDimensions: ['year'],
      measures: ['revenue', 'yoy_pct'],
    })
    const rows = await queryAll(conn, result.sql)

    // Leaf rows: correct YoY per dept
    expect(findRow(rows, { dept: 'Sales', year: 2022 }).yoy_pct).toBeNull()
    expect(findRow(rows, { dept: 'Sales', year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)
    expect(findRow(rows, { dept: 'Sales', year: 2024 }).yoy_pct).toBeCloseTo(0.25, 4)
    expect(findRow(rows, { dept: 'Ops',   year: 2023 }).yoy_pct).toBeCloseTo(0.20, 4)

    // Column subtotals (dept rolled up, year present): non-NULL YoY
    const colSub2023 = rows.find((r: any) => r['_g_dept'] === 1 && r['_g_year'] === 0 && r.year === 2023)
    expect(colSub2023).toBeDefined()
    expect(colSub2023!.yoy_pct).toBeCloseTo(0.20, 4)
    const colSub2024 = rows.find((r: any) => r['_g_dept'] === 1 && r['_g_year'] === 0 && r.year === 2024)
    expect(colSub2024!.yoy_pct).toBeCloseTo(0.25, 4)

    // Row subtotals (year rolled up): NULL
    expect(findRow(rows, { dept: 'Sales', year: null }).yoy_pct).toBeNull()
    expect(findRow(rows, { dept: 'Ops',   year: null }).yoy_pct).toBeNull()

    // Grand total: NULL
    expect(findRow(rows, { dept: null, year: null }).yoy_pct).toBeNull()
  })
})

describe('expandDimsVariable', () => {
  it('replaces $DIMS(x) with remaining dimensions', () => {
    const result = expandDimsVariable(
      'LAG(revenue) OVER (PARTITION BY $DIMS(year) ORDER BY year)',
      ['dept', 'region', 'year']
    )
    expect(result).toBe('LAG(revenue) OVER (PARTITION BY "dept", "region" ORDER BY year)')
  })

  it('replaces $DIMS(x) with 1 when no other dimensions', () => {
    const result = expandDimsVariable(
      'LAG(revenue) OVER (PARTITION BY $DIMS(year) ORDER BY year)',
      ['year']
    )
    expect(result).toBe('LAG(revenue) OVER (PARTITION BY 1 ORDER BY year)')
  })

  it('handles multiple $DIMS references in one expression', () => {
    const result = expandDimsVariable(
      'LAG(a) OVER (PARTITION BY $DIMS(year) ORDER BY year) + LEAD(b) OVER (PARTITION BY $DIMS(year) ORDER BY year)',
      ['dept', 'year']
    )
    expect(result).toContain('PARTITION BY "dept" ORDER BY year')
    expect(result).not.toContain('$DIMS')
  })

  it('excludes multiple dimensions with $DIMS(a, b)', () => {
    const result = expandDimsVariable(
      'LAG(revenue) OVER (PARTITION BY $DIMS(year, quarter) ORDER BY year, quarter)',
      ['dept', 'region', 'year', 'quarter']
    )
    expect(result).toBe('LAG(revenue) OVER (PARTITION BY "dept", "region" ORDER BY year, quarter)')
  })

  it('leaves expression unchanged when no $DIMS present', () => {
    const expr = 'revenue / LAG(revenue) OVER (PARTITION BY dept ORDER BY year) - 1'
    expect(expandDimsVariable(expr, ['dept', 'year'])).toBe(expr)
  })
})

describe('injectGroupingPartition', () => {
  it('injects into OVER (PARTITION BY X ORDER BY Y)', () => {
    const result = injectGroupingPartition(
      'LAG(revenue) OVER (PARTITION BY "dept" ORDER BY year)',
      ['_g_dept', '_g_year']
    )
    expect(result).toBe('LAG(revenue) OVER (PARTITION BY "_g_dept", "_g_year", "dept" ORDER BY year)')
  })

  it('injects into OVER (ORDER BY Y)', () => {
    const result = injectGroupingPartition(
      'LAG(revenue) OVER (ORDER BY year)',
      ['_g_dept', '_g_year']
    )
    expect(result).toBe('LAG(revenue) OVER (PARTITION BY "_g_dept", "_g_year" ORDER BY year)')
  })

  it('injects into empty OVER ()', () => {
    const result = injectGroupingPartition(
      'ROW_NUMBER() OVER ()',
      ['_g_dept']
    )
    expect(result).toBe('ROW_NUMBER() OVER (PARTITION BY "_g_dept")')
  })

  it('returns expression unchanged when no grouping cols', () => {
    const expr = 'LAG(revenue) OVER (ORDER BY year)'
    expect(injectGroupingPartition(expr, [])).toBe(expr)
  })
})

describe('resolveDimExprForSchema', () => {
  const dims = [
    { id: 'region', name: 'Region', sourceField: 'region' },
    { id: 'core_status', name: 'Core', sourceField: 'core',
      expression: `CASE WHEN "core" THEN 'Core' ELSE 'Non-core' END` },
    { id: 'bad_expr', name: 'Bad', sourceField: 'x',
      expression: `DROP TABLE data` },
  ] as DimensionDefinition[]

  it('returns the expression for derived dimensions, found by id', () => {
    expect(resolveDimExprForSchema({ dimensions: dims }, 'core_status'))
      .toBe(`CASE WHEN "core" THEN 'Core' ELSE 'Non-core' END`)
  })

  it('returns the quoted column for plain dimensions', () => {
    expect(resolveDimExprForSchema({ dimensions: dims }, 'region'))
      .toBe('"region"')
  })

  it('quotes the field when it matches no dimension', () => {
    expect(resolveDimExprForSchema({ dimensions: dims }, 'mystery'))
      .toBe('"mystery"')
  })

  it('falls back to the quoted id when the expression fails validation', () => {
    expect(resolveDimExprForSchema({ dimensions: dims }, 'bad_expr'))
      .toBe('"bad_expr"')
  })
})

// ── GROUPING() in a measure expression, on a dimension that left the pivot ──

describe('GROUPING() on a dimension the query does not group by', () => {
  let db: any
  let conn: any

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'country', sourceField: 'country' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      {
        // "Revenue per country, but only where countries are rolled up" — the
        // shape a real QCEW measure uses to blank itself at the detail level.
        id: 'rev_per_country', sourceField: 'revenue', aggregation: 'custom',
        expression: 'CASE WHEN GROUPING("country") = 1 THEN CAST(SUM("revenue") AS DOUBLE) / NULLIF(COUNT(DISTINCT "country"), 0) ELSE NULL END',
      },
    ],
  })

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (region VARCHAR, country VARCHAR, revenue DOUBLE);
      INSERT INTO data VALUES
        ('APAC', 'AU', 100), ('APAC', 'JP', 200),
        ('EMEA', 'UK', 300), ('EMEA', 'DE', 400);
    `)
  })

  afterAll(() => { conn.close(); db.close() })

  it('leaves the call alone while the dimension is grouped', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['revenue', 'rev_per_country'],
    })
    expect(sql).toContain('GROUPING("country") = 1')

    const rows = await queryAll(conn, sql)
    // Detail rows opt out; the region rows average over their two countries.
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).rev_per_country).toBe(null)
    expect(findRow(rows, { region: 'APAC', country: null }).rev_per_country).toBeCloseTo(150)
    expect(findRow(rows, { region: null, country: null }).rev_per_country).toBeCloseTo(250)
  })

  it('runs, instead of failing to bind, once the dimension is dropped', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue', 'rev_per_country'],
    })
    // The call had no grouping column left to refer to; DuckDB rejected the
    // whole query rather than the one measure.
    expect(sql).not.toContain('GROUPING("country")')

    const rows = await queryAll(conn, sql)
    // Every row now aggregates over all countries, so the measure applies
    // everywhere rather than blanking.
    expect(findRow(rows, { region: 'APAC' }).rev_per_country).toBeCloseTo(150)
    expect(findRow(rows, { region: 'EMEA' }).rev_per_country).toBeCloseTo(350)
    expect(findRow(rows, { region: null }).rev_per_country).toBeCloseTo(250)
  })

  it('counts a column-axis dimension as grouped', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['country'],
      measures: ['rev_per_country'],
    })
    expect(sql).toContain('GROUPING("country") = 1')
    const rows = await queryAll(conn, sql)
    // Grouped on the column axis, so the rule still applies per cell.
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).rev_per_country).toBe(null)
    expect(findRow(rows, { region: 'APAC', country: null }).rev_per_country).toBeCloseTo(150)
  })

  it('rewrites when the dimension is on neither axis', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: [],
      measures: ['rev_per_country'],
    })
    expect(sql).not.toContain('GROUPING("country")')
    const rows = await queryAll(conn, sql)
    expect(findRow(rows, { region: 'APAC' }).rev_per_country).toBeCloseTo(150)
  })

  // Flat mode is switched on automatically when a pivot overflows the row or
  // column limit, and it is the shape a NAICS-6-sized pivot actually reaches.
  // Its CTEs group by one axis, and its grand-total CTE by nothing, so a call
  // that binds in the outer ROLLUP does not bind inside them.
  it('binds inside the flat-mode CTEs, which group by one axis', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['country'],
      measures: ['rev_per_country'],
      limitRows: 2,
    })
    const rows = await queryAll(conn, sql)
    // country is on the column axis, so it is still grouped: the measure blanks
    // on the detail cells and computes on the rolled-up column.
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).rev_per_country).toBe(null)
    expect(findRow(rows, { region: 'APAC', country: null }).rev_per_country).toBeCloseTo(150)
    expect(findRow(rows, { region: 'EMEA', country: null }).rev_per_country).toBeCloseTo(350)
  })

  it('binds in flat mode with the dimension on rows', async () => {
    const { sql } = new QueryBuilder(schema).buildRollupAggregation({
      rowDimensions: ['region', 'country'],
      measures: ['rev_per_country'],
      limitRows: 4,
      limitCols: 4,
    })
    const rows = await queryAll(conn, sql)
    // country is on the pivot, so the measure keeps its blank-at-detail rule.
    expect(findRow(rows, { region: 'APAC', country: 'AU' }).rev_per_country).toBe(null)
    expect(findRow(rows, { region: 'APAC', country: null }).rev_per_country).toBeCloseTo(150)
  })

  // The top-N CTEs rank members by the first measure. Answering its GROUPING()
  // call for the whole query rather than for that CTE's own grouping set turned
  // the ORDER BY into a constant, and the ranking silently kept the smallest
  // members instead of the largest.
  it('ranks top-N members by a GROUPING-dependent measure correctly', async () => {
    const ranked = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
      ],
      measures: [
        { id: 'm', sourceField: 'revenue', aggregation: 'custom',
          expression: 'CASE WHEN GROUPING("country") = 1 THEN -999 ELSE CAST(SUM("revenue") AS DOUBLE) END' },
      ],
    })
    const { sql } = new QueryBuilder(ranked).buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['country'],
      measures: ['m'],
      limitCols: 2,
    })
    const rows = await queryAll(conn, sql)
    const kept = [...new Set(rows.map((r: any) => r.country).filter(Boolean))].sort()
    // UK=300 and DE=400 are the two largest; AU=100 and JP=200 the two smallest.
    expect(kept).toEqual(['DE', 'UK'])
  })
})

describe('neutralizeUngroupedGrouping', () => {
  it('keeps calls on grouped dimensions', () => {
    expect(neutralizeUngroupedGrouping('GROUPING("a") = 1', new Set(['a'])))
      .toBe('GROUPING("a") = 1')
  })

  it('replaces calls on dimensions that are not grouped', () => {
    expect(neutralizeUngroupedGrouping('GROUPING("a") = 1', new Set(['b'])))
      .toBe('1 = 1')
  })

  it('handles unquoted identifiers and odd spacing', () => {
    expect(neutralizeUngroupedGrouping('GROUPING ( a )', new Set(['b']))).toBe('1')
    expect(neutralizeUngroupedGrouping('GROUPING ( a )', new Set(['a']))).toBe('GROUPING ( a )')
  })

  it('leaves an expression with no GROUPING() untouched', () => {
    expect(neutralizeUngroupedGrouping('SUM("x")', new Set())).toBe('SUM("x")')
  })

  it('does not reach inside a string literal', () => {
    const expr = `CASE WHEN x THEN 'GROUPING("a")' ELSE 'y' END`
    expect(neutralizeUngroupedGrouping(expr, new Set(['b']))).toBe(expr)
  })

  it('is not thrown off by an apostrophe inside a quoted identifier', () => {
    const expr = `CASE WHEN "it's" THEN 'GROUPING("a")' ELSE 0 END`
    expect(neutralizeUngroupedGrouping(expr, new Set(['b']))).toBe(expr)
    expect(neutralizeUngroupedGrouping(`"it's" || GROUPING("a")`, new Set(['b'])))
      .toBe(`"it's" || 1`)
  })

  it('steps over an escaped quote without losing its place', () => {
    expect(neutralizeUngroupedGrouping(`'it''s' || GROUPING("a")`, new Set(['b'])))
      .toBe(`'it''s' || 1`)
  })

  it('leaves lookalike functions alone', () => {
    for (const expr of ['GROUPING_ID("a")', 'MY_GROUPING("a")', 'X.GROUPING("a")']) {
      expect(neutralizeUngroupedGrouping(expr, new Set(['b']))).toBe(expr)
    }
  })

  it('leaves the bitmask form alone, having no single constant for it', () => {
    expect(neutralizeUngroupedGrouping('GROUPING("a", "b")', new Set(['b'])))
      .toBe('GROUPING("a", "b")')
  })

  it('leaves a qualified reference alone', () => {
    expect(neutralizeUngroupedGrouping('GROUPING("t"."c")', new Set(['b'])))
      .toBe('GROUPING("t"."c")')
  })

  it('decides each call independently', () => {
    expect(neutralizeUngroupedGrouping('GROUPING("a") + GROUPING("b")', new Set(['a'])))
      .toBe('GROUPING("a") + 1')
  })
})
