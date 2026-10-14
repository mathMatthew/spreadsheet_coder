import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { QueryBuilder, type RollupResult } from './query-builder'
import { makeSchema, queryAll, exec, normalize } from './test-helpers'
import duckdb from 'duckdb'

// ── Sort test data ───────────────────────────────────────────────────
//
//   region | product | quarter | revenue
//   APAC   | Widget  | Q1      | 100
//   APAC   | Widget  | Q2      |  10
//   APAC   | Gadget  | Q1      |   5
//   AMER   | Widget  | Q1      |  60
//   EMEA   | Widget  | Q1      |  20
//   EMEA   | Gadget  | Q1      |   3
//
// Region totals:  APAC 115, AMER 60, EMEA 23   (alphabetical: AMER, APAC, EMEA)
// Quarter totals: Q1 188, Q2 10                (alphabetical: Q1, Q2)
//
// Every ordering below is chosen so the alphabetical answer and the by-measure
// answer differ — a test that passed on default ordering would prove nothing.

const SCHEMA = makeSchema({
  dimensions: [
    { id: 'region', sourceField: 'region' },
    { id: 'product', sourceField: 'product' },
    { id: 'quarter', sourceField: 'quarter' },
  ],
  measures: [
    { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
  ],
})

const ROLLED_UP = '·'

/**
 * The row-axis skeleton in result order: one entry per row of the report,
 * looking only at the cells where every column dimension is rolled up (the
 * row-total column), so the list reads as the report's rows top to bottom.
 * A rolled-up dimension shows as '·', so a region subtotal is "APAC|·".
 */
function rowSkeleton(rows: Record<string, any>[], rollup: RollupResult): string[] {
  const { dimensionFields, rowDimensionCount } = rollup
  const rowDims = dimensionFields.slice(0, rowDimensionCount)
  const colDims = dimensionFields.slice(rowDimensionCount)
  return rows
    .filter(r => colDims.every(d => Number(r[`_g_${d}`]) === 1))
    .map(r => rowDims.map(d => Number(r[`_g_${d}`]) === 1 ? ROLLED_UP : String(normalize(r[d]))).join('|'))
}

/** The column members in result order, taken from the grand-total row band. */
function columnOrder(rows: Record<string, any>[], rollup: RollupResult): string[] {
  const { dimensionFields, rowDimensionCount } = rollup
  const rowDims = dimensionFields.slice(0, rowDimensionCount)
  const colDims = dimensionFields.slice(rowDimensionCount)
  return rows
    .filter(r => rowDims.every(d => Number(r[`_g_${d}`]) === 1))
    .filter(r => colDims.every(d => Number(r[`_g_${d}`]) === 0))
    .map(r => colDims.map(d => String(normalize(r[d]))).join('|'))
}

describe('QueryBuilder report sort', () => {
  let db: any
  let conn: any
  let qb: QueryBuilder

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        product VARCHAR,
        quarter VARCHAR,
        revenue DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'Widget', 'Q1', 100),
        ('APAC', 'Widget', 'Q2',  10),
        ('APAC', 'Gadget', 'Q1',   5),
        ('AMER', 'Widget', 'Q1',  60),
        ('EMEA', 'Widget', 'Q1',  20),
        ('EMEA', 'Gadget', 'Q1',   3);
    `)
    qb = new QueryBuilder(SCHEMA)
  })

  afterAll(() => {
    conn?.close()
    db?.close()
  })

  // ── Default behaviour is untouched ─────────────────────────────────

  it('leaves the query alone when no sort is set', () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
    })
    expect(rollup.sql).not.toContain('_presort')
  })

  it('orders rows by dimension value when no sort is set', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
  })

  // ── Sorting by one column's values ─────────────────────────────────
  //
  // With region on rows and product on columns:
  //   Gadget column: APAC 5, EMEA 3, AMER none
  //   whole row:     APAC 115, AMER 60, EMEA 23
  // so ranking by the Gadget column has to put EMEA above AMER, which ranking by
  // the row total never would. That is the difference these tests turn on.

  const byProduct = (sort?: any) => qb.buildRollupAggregation({
    rowDimensions: ['region'],
    columnDimensions: ['product'],
    measures: ['revenue'],
    ...(sort ? { sort } : {}),
  })

  it('ranks rows by the named column, not by the row total', async () => {
    const rollup = byProduct({ by: 'measure', measure: 'revenue', axis: 'rows', direction: 'desc', colPath: ['Gadget'] })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'EMEA', 'AMER', ROLLED_UP])
  })

  it('reverses that ranking for an ascending column sort', async () => {
    const rollup = byProduct({ by: 'measure', measure: 'revenue', axis: 'rows', direction: 'asc', colPath: ['Gadget'] })
    const rows = await queryAll(conn, rollup.sql)
    // AMER has no Gadget row at all, so it sorts last either way (NULLS LAST).
    expect(rowSkeleton(rows, rollup)).toEqual(['EMEA', 'APAC', 'AMER', ROLLED_UP])
  })

  it('still ranks by the row total when no column is named', async () => {
    const rollup = byProduct({ by: 'measure', measure: 'revenue', axis: 'rows', direction: 'desc' })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
  })

  it('falls back to dimension order when the named column is gone', async () => {
    // A bookmark saved against a column value that no longer exists must still
    // open, ordered by something stable, rather than failing.
    const rollup = byProduct({ by: 'measure', measure: 'revenue', axis: 'rows', direction: 'desc', colPath: ['Sprocket'] })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
  })

  // ── Sorting rows by a measure ──────────────────────────────────────

  it('orders rows by a measure, descending, with the grand total last', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
  })

  it('orders rows by a measure, ascending', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', direction: 'asc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['EMEA', 'AMER', 'APAC', ROLLED_UP])
  })

  it('keeps every subtotal under the rows it summarises', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region', 'product'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    // Regions ranked by their own total (APAC 115, AMER 60, EMEA 23), products
    // ranked within each region, and each region's subtotal immediately after
    // its own products rather than adrift among another region's rows.
    expect(rowSkeleton(rows, rollup)).toEqual([
      'APAC|Widget',
      'APAC|Gadget',
      `APAC|${ROLLED_UP}`,
      'AMER|Widget',
      `AMER|${ROLLED_UP}`,
      'EMEA|Widget',
      'EMEA|Gadget',
      `EMEA|${ROLLED_UP}`,
      `${ROLLED_UP}|${ROLLED_UP}`,
    ])
  })

  it('ranks rows by the row total, not by whichever column cell comes first', async () => {
    // Q1 alone would put AMER (60) above APAC (100 in Q1)? No — the trap is the
    // other way round: sorting on a single column would reorder the report as the
    // column set changes. The row total is what ranks, so APAC (115) leads.
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['quarter'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
    // Columns keep their default order — only the row axis was sorted.
    expect(columnOrder(rows, rollup)).toEqual(['Q1', 'Q2'])
  })

  it('sorts a member and its per-column cells as one block', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['quarter'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    // Every row of the result, in order, reduced to its region: each region's
    // cells are contiguous, so no region is split across another.
    const regions = rows.map(r => Number(r._g_region) === 1 ? ROLLED_UP : String(r.region))
    const firstSeen: string[] = []
    for (const r of regions) if (firstSeen[firstSeen.length - 1] !== r) firstSeen.push(r)
    expect(firstSeen).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
  })

  // ── Sorting columns by a measure ───────────────────────────────────

  it('orders column members by a measure when the sort targets the column axis', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['quarter'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', axis: 'columns', direction: 'asc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    // Q2 (10) before Q1 (188), the reverse of both the alphabetical and the
    // descending answer.
    expect(columnOrder(rows, rollup)).toEqual(['Q2', 'Q1'])
    expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
  })

  // ── Sorting by a dimension ─────────────────────────────────────────

  it('orders rows by a dimension in the requested direction', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'dimension', field: 'region', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['EMEA', 'APAC', 'AMER', ROLLED_UP])
  })

  it('sorts only the named dimension level, leaving the others alone', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region', 'product'],
      measures: ['revenue'],
      sort: { by: 'dimension', field: 'product', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual([
      'AMER|Widget',
      `AMER|${ROLLED_UP}`,
      'APAC|Widget',
      'APAC|Gadget',
      `APAC|${ROLLED_UP}`,
      'EMEA|Widget',
      'EMEA|Gadget',
      `EMEA|${ROLLED_UP}`,
      `${ROLLED_UP}|${ROLLED_UP}`,
    ])
  })

  it('finds the axis of a dimension sort on the column axis', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['quarter'],
      measures: ['revenue'],
      sort: { by: 'dimension', field: 'quarter', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(columnOrder(rows, rollup)).toEqual(['Q2', 'Q1'])
  })

  // ── Percentage display modes ───────────────────────────────────────

  for (const mode of ['pct_row', 'pct_col', 'pct_total'] as const) {
    it(`sorts by a measure in ${mode} mode`, async () => {
      const rollup = qb.buildRollupAggregation({
        rowDimensions: ['region'],
        columnDimensions: ['quarter'],
        measures: ['revenue'],
        displayMode: mode,
        sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
      })
      const rows = await queryAll(conn, rollup.sql)
      expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
      // The percentage columns still come back alongside the values.
      expect(rollup.percentageFields).toEqual(['revenue_pct'])
      expect(rows.every(r => 'revenue_pct' in r)).toBe(true)
    })
  }

  // ── sortExpression interaction ─────────────────────────────────────

  describe('against a schema sortExpression', () => {
    const sortExprSchema = makeSchema({
      dimensions: [
        // Orders regions by their length, then value: EMEA/APAC/AMER all length 4,
        // so on its own this reproduces alphabetical order — what matters below is
        // that it is a MIN(expression) key, not the dimension value.
        { id: 'region', sourceField: 'region', sortExpression: `CASE region WHEN 'EMEA' THEN 1 WHEN 'APAC' THEN 2 ELSE 3 END` },
        { id: 'product', sourceField: 'product' },
      ],
      measures: [{ id: 'revenue', sourceField: 'revenue', aggregation: 'sum' }],
    })

    it('follows the sortExpression when no report sort is set', async () => {
      const b = new QueryBuilder(sortExprSchema)
      const rollup = b.buildRollupAggregation({ rowDimensions: ['region'], measures: ['revenue'] })
      const rows = await queryAll(conn, rollup.sql)
      expect(rowSkeleton(rows, rollup)).toEqual(['EMEA', 'APAC', 'AMER', ROLLED_UP])
    })

    it('is overridden by a report sort on a measure', async () => {
      const b = new QueryBuilder(sortExprSchema)
      const rollup = b.buildRollupAggregation({
        rowDimensions: ['region'],
        measures: ['revenue'],
        sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
      })
      const rows = await queryAll(conn, rollup.sql)
      expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
    })

    it('reverses the sortExpression when the report sorts that dimension descending', async () => {
      const b = new QueryBuilder(sortExprSchema)
      const rollup = b.buildRollupAggregation({
        rowDimensions: ['region'],
        measures: ['revenue'],
        sort: { by: 'dimension', field: 'region', direction: 'desc' },
      })
      const rows = await queryAll(conn, rollup.sql)
      expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
    })

    it('keeps the sortExpression for the levels the report sort does not name', async () => {
      const b = new QueryBuilder(sortExprSchema)
      const rollup = b.buildRollupAggregation({
        rowDimensions: ['region', 'product'],
        measures: ['revenue'],
        sort: { by: 'dimension', field: 'product', direction: 'desc' },
      })
      const rows = await queryAll(conn, rollup.sql)
      const regions = rowSkeleton(rows, rollup).map(s => s.split('|')[0])
      expect(regions[0]).toBe('EMEA')  // sortExpression order, not alphabetical
    })
  })

  // ── Sorts that no longer apply ─────────────────────────────────────

  it('ignores a sort naming a measure that is not in the query', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'gone', direction: 'desc' },
    })
    expect(rollup.sql).not.toContain('_presort')
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
  })

  it('ignores a sort naming a dimension that is on neither axis', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'dimension', field: 'product', direction: 'desc' },
    })
    expect(rollup.sql).not.toContain('_presort')
  })

  it('ignores a column-axis sort when the report has no column dimensions', () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      sort: { by: 'measure', measure: 'revenue', axis: 'columns', direction: 'desc' },
    })
    expect(rollup.sql).not.toContain('_presort')
  })

  // ── Other query shapes ─────────────────────────────────────────────

  it('sorts a report whose measure is a custom expression', async () => {
    const customSchema = makeSchema({
      dimensions: [{ id: 'region', sourceField: 'region' }],
      measures: [{ id: 'avg_rev', sourceField: 'revenue', aggregation: 'custom', expression: 'SUM(revenue) / COUNT(*)' }],
    })
    const b = new QueryBuilder(customSchema)
    const rollup = b.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['avg_rev'],
      sort: { by: 'measure', measure: 'avg_rev', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    // AMER 60/1, APAC 115/3 = 38.3, EMEA 23/2 = 11.5
    expect(rowSkeleton(rows, rollup)).toEqual(['AMER', 'APAC', 'EMEA', ROLLED_UP])
  })

  it('sorts a report with a derived comparison measure', async () => {
    const derivedSchema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'quarter', sourceField: 'quarter' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        {
          id: 'rev_share', sourceField: 'revenue',
          derivedExpression: 'revenue / NULLIF(SUM(revenue) OVER (), 0)',
          dependsOn: ['revenue'],
        },
      ],
    })
    const b = new QueryBuilder(derivedSchema)
    const rollup = b.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue', 'rev_share'],
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    expect(rowSkeleton(rows, rollup)).toEqual(['APAC', 'AMER', 'EMEA', ROLLED_UP])
  })

  it('sorts a top-N (flat mode) report and keeps its true totals at the end', async () => {
    const rollup = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      columnDimensions: ['quarter'],
      measures: ['revenue'],
      limitRows: 2,
      sort: { by: 'measure', measure: 'revenue', direction: 'desc' },
    })
    const rows = await queryAll(conn, rollup.sql)
    const rollupOnly = rows.filter(r => r._tt == null || Number(r._tt) === 0)
    expect(rowSkeleton(rollupOnly, rollup)).toEqual(['APAC', 'AMER', ROLLED_UP])
    // The true-total rows are still there, and still after the ROLLUP rows.
    const firstTrueTotal = rows.findIndex(r => Number(r._tt) > 0)
    expect(firstTrueTotal).toBeGreaterThan(-1)
    expect(rows.slice(firstTrueTotal).every(r => Number(r._tt) > 0)).toBe(true)
  })
})
