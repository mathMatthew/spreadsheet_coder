/**
 * Tests that chunked summary creation produces identical results to one-shot creation.
 * Uses real DuckDB execution (Node driver) to verify SQL equivalence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'


import { buildSummarySelectSQL, getEligibleMeasureIds } from './summary-views'
import type { QuerySchema } from './query-builder'
import duckdb from 'duckdb'
import { makeSchema, queryAll, exec, sortRows } from './test-helpers'

// ── Chunked summary equivalence ──────────────────────────────────────

describe('chunked summary equivalence', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (
        region VARCHAR,
        country VARCHAR,
        product VARCHAR,
        month DATE,
        region_name VARCHAR,
        revenue DOUBLE
      );
      INSERT INTO data VALUES
        ('APAC', 'AU',  'Widget',   DATE '2025-01-01', 'Asia Pacific',   100),
        ('APAC', 'AU',  'Gadget',   DATE '2025-01-01', 'Asia Pacific',   150),
        ('APAC', 'AU',  'Widget',   DATE '2025-04-01', 'Asia Pacific',   200),
        ('APAC', 'JP',  'Widget',   DATE '2025-01-01', 'Asia Pacific',   300),
        ('APAC', 'JP',  'Gadget',   DATE '2025-04-01', 'Asia Pacific',   250),
        ('APAC', 'JP',  'Widget',   DATE '2025-07-01', 'Asia Pacific',   400),
        ('EMEA', 'UK',  'Widget',   DATE '2025-01-01', 'Europe & ME',     50),
        ('EMEA', 'UK',  'Gadget',   DATE '2025-04-01', 'Europe & ME',     60),
        ('EMEA', 'DE',  'Widget',   DATE '2025-01-01', 'Europe & ME',     80),
        ('EMEA', 'DE',  'Gadget',   DATE '2025-07-01', 'Europe & ME',     90),
        ('EMEA', 'DE',  'Widget',   DATE '2025-04-01', 'Europe & ME',    110),
        ('AMER', 'US',  'Widget',   DATE '2025-01-01', 'Americas',       500),
        ('AMER', 'US',  'Gadget',   DATE '2025-04-01', 'Americas',       600),
        ('AMER', 'CA',  'Widget',   DATE '2025-07-01', 'Americas',       350),
        ('AMER', 'CA',  'Gadget',   DATE '2025-01-01', 'Americas',       400),
        (NULL,   'XX',  'Widget',   DATE '2025-01-01', NULL,             999);
    `)
  })

  afterAll(() => {
    db?.close()
  })

  /** Get distinct values for a column from the data table. */
  async function getDistinctValues(column: string): Promise<(string | null)[]> {
    const rows = await queryAll(conn, `SELECT DISTINCT "${column}" FROM data ORDER BY "${column}"`)
    return rows.map(r => r[column])
  }

  /** Run one-shot summary, then chunk by a dimension, and compare. */
  async function compareOneShotVsChunked(
    schema: QuerySchema,
    dims: string[],
    chunkDim: string
  ): Promise<void> {
    // One-shot: no WHERE clause
    const oneShotSQL = buildSummarySelectSQL(schema, dims)
    const oneShotRows = await queryAll(conn, oneShotSQL)

    // Chunked: get distinct values of the chunk dimension, run per-value
    const chunkValues = await getDistinctValues(chunkDim)
    const chunkedRows: Record<string, any>[] = []

    for (const val of chunkValues) {
      const whereClause = val === null
        ? `"${chunkDim}" IS NULL`
        : `"${chunkDim}" = '${val}'`
      const chunkSQL = buildSummarySelectSQL(schema, dims, whereClause)
      const rows = await queryAll(conn, chunkSQL)
      chunkedRows.push(...rows)
    }

    const sortedOneShot = sortRows(oneShotRows)
    const sortedChunked = sortRows(chunkedRows)

    expect(sortedChunked).toEqual(sortedOneShot)
  }

  // ── Test 1: One-shot matches chunked by region ──

  it('one-shot matches chunked by region', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'product', sourceField: 'product' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    await compareOneShotVsChunked(schema, ['region', 'country', 'product'], 'region')
  })

  // ── Test 2: Chunked by higher-cardinality dimension (country) ──

  it('chunked by higher-cardinality dimension (country)', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'country', sourceField: 'country' },
        { id: 'product', sourceField: 'product' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    await compareOneShotVsChunked(schema, ['region', 'country', 'product'], 'country')
  })

  // ── Test 3: With derived dimensions ──

  it('with derived dimensions (quarter from month)', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'month', sourceField: 'month' },
        {
          id: 'quarter',
          sourceField: 'quarter',
          expression: "QUARTER(CAST(\"month\" AS DATE))",
          derivedFromField: 'month',
        },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    // Summary includes month (physical) → quarter (derived) is auto-included
    const dims = ['region', 'month']

    const oneShotSQL = buildSummarySelectSQL(schema, dims)
    const oneShotRows = await queryAll(conn, oneShotSQL)

    // Verify derived column exists in results
    expect(oneShotRows.length).toBeGreaterThan(0)
    expect(oneShotRows[0]).toHaveProperty('quarter')

    // Chunk by region
    const chunkValues = await getDistinctValues('region')
    const chunkedRows: Record<string, any>[] = []
    for (const val of chunkValues) {
      const whereClause = val === null
        ? '"region" IS NULL'
        : `"region" = '${val}'`
      const chunkSQL = buildSummarySelectSQL(schema, dims, whereClause)
      const rows = await queryAll(conn, chunkSQL)
      chunkedRows.push(...rows)
    }

    const sortedOneShot = sortRows(oneShotRows)
    const sortedChunked = sortRows(chunkedRows)

    expect(sortedChunked).toEqual(sortedOneShot)

    // Verify quarter values are correct
    for (const row of sortedOneShot) {
      const month = row.month instanceof Date ? row.month.getMonth() : null
      if (month !== null) {
        const expectedQuarter = Math.floor(month / 3) + 1
        expect(row.quarter).toBe(expectedQuarter)
      }
    }
  })

  // ── Test 4: With description fields ──

  it('with description fields', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region', descriptionField: 'region_name' },
        { id: 'product', sourceField: 'product' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    const dims = ['region', 'product']

    const oneShotSQL = buildSummarySelectSQL(schema, dims)
    const oneShotRows = await queryAll(conn, oneShotSQL)

    // Verify description column present
    expect(oneShotRows.length).toBeGreaterThan(0)
    expect(oneShotRows[0]).toHaveProperty('region_name')

    // Chunk by product
    const chunkValues = await getDistinctValues('product')
    const chunkedRows: Record<string, any>[] = []
    for (const val of chunkValues) {
      const whereClause = `"product" = '${val}'`
      const chunkSQL = buildSummarySelectSQL(schema, dims, whereClause)
      const rows = await queryAll(conn, chunkSQL)
      chunkedRows.push(...rows)
    }

    const sortedOneShot = sortRows(oneShotRows)
    const sortedChunked = sortRows(chunkedRows)

    expect(sortedChunked).toEqual(sortedOneShot)

    // Verify description values match the expected mapping
    for (const row of sortedOneShot) {
      if (row.region === 'APAC') expect(row.region_name).toBe('Asia Pacific')
      if (row.region === 'EMEA') expect(row.region_name).toBe('Europe & ME')
      if (row.region === 'AMER') expect(row.region_name).toBe('Americas')
    }
  })

  // ── Test 5: Chunk with NULL values ──

  it('chunk with NULL values in chunk dimension', async () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'product', sourceField: 'product' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    const dims = ['region', 'product']

    // One-shot
    const oneShotSQL = buildSummarySelectSQL(schema, dims)
    const oneShotRows = await queryAll(conn, oneShotSQL)

    // Verify there's a NULL region in the data
    const hasNull = oneShotRows.some(r => r.region === null)
    expect(hasNull).toBe(true)

    // Chunk by region — must handle NULL explicitly
    const chunkValues = await getDistinctValues('region')
    expect(chunkValues).toContain(null)  // data includes a NULL region row

    const chunkedRows: Record<string, any>[] = []
    for (const val of chunkValues) {
      const whereClause = val === null
        ? '"region" IS NULL'
        : `"region" = '${val}'`
      const chunkSQL = buildSummarySelectSQL(schema, dims, whereClause)
      const rows = await queryAll(conn, chunkSQL)
      chunkedRows.push(...rows)
    }

    const sortedOneShot = sortRows(oneShotRows)
    const sortedChunked = sortRows(chunkedRows)

    expect(sortedChunked).toEqual(sortedOneShot)

    // Verify the NULL chunk row is present with correct revenue
    const nullRow = sortedChunked.find(r => r.region === null)
    expect(nullRow).toBeDefined()
    expect(nullRow!.revenue).toBe(999)
  })
})

// ── Edge cases that must still produce runnable SQL ──────────────────

describe('summary SQL edge cases', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (region VARCHAR, revenue DOUBLE, cost DOUBLE);
      INSERT INTO data VALUES ('APAC', 100, 40), ('EMEA', 50, 20), ('APAC', 25, 5);
    `)
  })

  afterAll(() => {
    db?.close()
  })

  it('a view with no dimensions is one grand-total row', async () => {
    const schema = makeSchema({ measures: [{ id: 'revenue', sourceField: 'revenue' }] })
    const sql = buildSummarySelectSQL(schema, [])
    expect(sql).not.toContain('GROUP BY')
    const rows = await queryAll(conn, sql)
    expect(rows).toEqual([{ revenue: 175 }])
  })

  it('leaves out SUM measures that share a sourceField, and keeps the rest', async () => {
    const schema = makeSchema({
      dimensions: [{ id: 'region', sourceField: 'region' }],
      measures: [
        { id: 'revenue', sourceField: 'revenue' },
        { id: 'revenue_net', sourceField: 'revenue', expression: 'revenue - cost' },
        { id: 'cost', sourceField: 'cost' },
      ],
    })
    expect(getEligibleMeasureIds(schema)).toEqual(['cost'])
    const sql = buildSummarySelectSQL(schema, ['region'])
    await exec(conn, `CREATE TABLE view_dup AS ${sql}`)
    const rows = sortRows(await queryAll(conn, 'SELECT * FROM view_dup'))
    expect(rows).toEqual([{ region: 'APAC', cost: 45 }, { region: 'EMEA', cost: 20 }])
  })
})
