/**
 * A summary view built at a derived dimension's own grain.
 *
 * A dimension computed from a column — HS chapter from the six-digit code — used
 * to be available only as a passenger on a view that already carried the code, so
 * the view was as tall as the leaf level and the hierarchy bought nothing. These
 * tests cover grouping by the expression alone: the SQL that builds such a view,
 * the routing that picks it, and the SQL that then reads it.
 *
 * Real DuckDB execution, so the numbers are checked against base data rather than
 * against another string of SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'


import {
  buildSummarySelectSQL,
  computeViewDimensions,
  findBestView,
  findDerivedGrain,
  type SummaryViewMetadata,
} from './summary-views'
import { QueryBuilder, type QuerySchema } from './query-builder'
import duckdb from 'duckdb'
import { makeSchema, queryAll, exec, sortRows } from './test-helpers'

/** hs6_code is a real column; section and chapter are computed from it. */
function tradeSchema(): QuerySchema {
  const schema = makeSchema({
    dimensions: [
      { id: 'hs6_code', displayName: 'HS6 Code', sourceField: 'hs6_code' },
      { id: 'year', displayName: 'Year', sourceField: 'year' },
      {
        id: 'hs_chapter',
        displayName: 'HS Chapter',
        sourceField: undefined as any,
        expression: 'SUBSTR("hs6_code", 1, 2)',
        derivedFromField: 'hs6_code',
      },
    ],
    measures: [{ id: 'value', displayName: 'Trade Value', sourceField: 'value' }],
  })
  // makeSchema defaults sourceField to the id; a derived dimension has no column
  const chapter = schema.dimensions.find(d => d.id === 'hs_chapter')!
  delete (chapter as any).sourceField
  return schema
}

function view(name: string, dimensions: string[], rowCount: number): SummaryViewMetadata {
  return { name, dimensions, measures: ['value'], datasetName: 'trade', createdAt: 0, rowCount }
}

describe('summary view at a derived dimension grain', () => {
  let db: any
  let conn: any
  const schema = tradeSchema()

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE data (hs6_code VARCHAR, year INTEGER, value DOUBLE);
      INSERT INTO data VALUES
        ('850110', 2023, 100), ('850120', 2023, 150), ('850110', 2024, 200),
        ('851220', 2023,  50), ('851230', 2024,  60), ('850190', 2024,  90),
        ('271011', 2023, 500), ('271019', 2023, 600), ('271011', 2024, 350),
        ('271099', 2024, 400), ('870321', 2023,  80), ('870322', 2024, 110),
        ('870390', 2023,  70);
    `)
  })

  afterAll(() => { db?.close() })

  it('groups by the expression and does not carry the column it reads', async () => {
    const sql = buildSummarySelectSQL(schema, ['hs_chapter', 'year'])

    expect(sql).toContain('SUBSTR("hs6_code", 1, 2) AS "hs_chapter"')

    const rows = await queryAll(conn, sql)
    // hs6_code appears inside the expression but is not a column of the result
    expect(Object.keys(rows[0]).sort()).toEqual(['hs_chapter', 'value', 'year'])
    expect(rows.map(r => r.hs_chapter).sort()).toEqual(
      ['27', '27', '85', '85', '87', '87']
    )
  })

  it('totals match base data, at a fraction of the rows', async () => {
    const viewSQL = buildSummarySelectSQL(schema, ['hs_chapter', 'year'])
    const fromView = sortRows(await queryAll(conn, viewSQL))

    const fromBase = sortRows(await queryAll(conn, `
      SELECT SUBSTR("hs6_code", 1, 2) AS hs_chapter, "year",
             CAST(SUM("value") AS DOUBLE) AS "value"
      FROM data GROUP BY 1, 2
    `))

    expect(fromView).toEqual(fromBase)

    const leaf = await queryAll(conn, `SELECT DISTINCT hs6_code, year FROM data`)
    expect(fromView.length).toBeLessThan(leaf.length)
  })

  it('re-aggregating the view to chapter alone matches base data', async () => {
    await exec(conn, `CREATE TABLE sv_chapter_year AS ${buildSummarySelectSQL(schema, ['hs_chapter', 'year'])}`)

    const fromView = sortRows(await queryAll(conn,
      `SELECT "hs_chapter", SUM("value") AS v FROM sv_chapter_year GROUP BY 1`))
    const fromBase = sortRows(await queryAll(conn,
      `SELECT SUBSTR("hs6_code", 1, 2) AS hs_chapter, SUM("value") AS v FROM data GROUP BY 1`))

    expect(fromView).toEqual(fromBase)
  })

  it('reads the materialised column rather than re-deriving from a column the view lacks', async () => {
    await exec(conn, `CREATE TABLE sv_chapter AS ${buildSummarySelectSQL(schema, ['hs_chapter', 'year'])}`)

    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildAggregation({
      dimensions: ['hs_chapter'],
      values: [{ field: 'value', aggregation: 'sum' } as any],
      source: 'sv_chapter',
      preAggregated: true,
      viewDimensions: ['hs_chapter', 'year'],
    })

    // The expression would reference hs6_code, which this view does not have
    expect(sql).not.toContain('hs6_code')
    const rows = await queryAll(conn, sql)
    expect(rows.length).toBe(3)
  })

  it('still re-derives when the view carries the source column', () => {
    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildAggregation({
      dimensions: ['hs_chapter'],
      values: [{ field: 'value', aggregation: 'sum' } as any],
      source: 'sv_code',
      preAggregated: true,
      viewDimensions: ['hs6_code', 'hs_chapter'],
    })
    expect(sql).toContain('SUBSTR("hs6_code", 1, 2)')
  })

  it('re-derives when the caller says nothing about the view columns', () => {
    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildAggregation({
      dimensions: ['hs_chapter'],
      values: [{ field: 'value', aggregation: 'sum' } as any],
      source: 'sv_code',
      preAggregated: true,
    })
    expect(sql).toContain('SUBSTR("hs6_code", 1, 2)')
  })
})

describe('routing to a derived-grain view', () => {
  const schema = tradeSchema()

  it('picks the chapter-grain view over the leaf view for a chapter query', () => {
    const views = [
      view('sv_code', ['hs6_code', 'year'], 5000),
      view('sv_chapter', ['hs_chapter', 'year'], 96),
    ]
    const best = findBestView(views, new Set(['hs_chapter', 'year']), ['value'], schema)
    expect(best?.name).toBe('sv_chapter')
  })

  it('does not send an hs6 query to the chapter-grain view', () => {
    const views = [view('sv_chapter', ['hs_chapter', 'year'], 96)]
    const best = findBestView(views, new Set(['hs6_code']), ['value'], schema)
    expect(best).toBeNull()
  })

  it('leaves the ride-along path intact', () => {
    const views = [view('sv_code', ['hs6_code', 'year'], 5000)]
    const best = findBestView(views, new Set(['hs_chapter']), ['value'], schema)
    expect(best?.name).toBe('sv_code')
  })

  it('does not list a derived grain twice in the view dimensions', () => {
    // The input that catches it: ticking a leaf checks its hierarchy parents, so
    // a selection carrying both a derived level and the column it reads is the
    // ordinary case, not an odd one. Without the guard hs_chapter appears twice.
    expect(computeViewDimensions(schema, ['hs6_code', 'hs_chapter']))
      .toEqual(['hs6_code', 'hs_chapter'])

    expect(computeViewDimensions(schema, ['hs_chapter', 'year']))
      .toEqual(['hs_chapter', 'year'])
    expect(computeViewDimensions(schema, ['hs6_code']))
      .toEqual(['hs6_code', 'hs_chapter'])
  })
})

describe('a selection entry that could name either kind of dimension', () => {
  it('reads the column when a physical dimension already claims that name', () => {
    // 'period' is one dimension's column and another's id. Treating it as the
    // derived one would silently group by years and label them fiscal periods.
    const schema = makeSchema({
      dimensions: [
        { id: 'fiscal_period', displayName: 'Fiscal Period', sourceField: 'period' },
        { id: 'region', displayName: 'Region', sourceField: 'region' },
      ],
      measures: [{ id: 'value', displayName: 'Value', sourceField: 'value' }],
    })
    schema.dimensions.push({
      id: 'period',
      displayName: 'Year',
      expression: 'YEAR("order_date")',
      derivedFromField: 'order_date',
    } as any)

    expect(findDerivedGrain(schema, 'period')).toBeNull()

    const sql = buildSummarySelectSQL(schema, ['period', 'region'])
    expect(sql).toContain('"period", "region"')
    expect(sql).not.toContain('YEAR("order_date")')
  })

  it('leaves a dimension named after the column it reads as a passenger', () => {
    // id === derivedFromField: once materialised the expression's output and its
    // input share a column name, and nothing downstream can tell them apart.
    const schema = makeSchema({
      dimensions: [{ id: 'year', displayName: 'Year', sourceField: 'year' }],
      measures: [{ id: 'value', displayName: 'Value', sourceField: 'value' }],
    })
    schema.dimensions.push({
      id: 'chapter',
      displayName: 'Chapter',
      expression: `CASE WHEN "chapter" = '27' THEN 'Fuels' ELSE "chapter" END`,
      derivedFromField: 'chapter',
    } as any)

    expect(findDerivedGrain(schema, 'chapter')).toBeNull()
  })
})

describe('a derived grain with a description column', () => {
  it('carries the description column so a display lookup can read it', () => {
    const schema = makeSchema({
      dimensions: [{ id: 'year', displayName: 'Year', sourceField: 'year' }],
      measures: [{ id: 'value', displayName: 'Value', sourceField: 'value' }],
    })
    schema.dimensions.push({
      id: 'hs_chapter',
      displayName: 'HS Chapter',
      expression: 'SUBSTR("hs6_code", 1, 2)',
      derivedFromField: 'hs6_code',
      descriptionField: 'chapter_name',
    } as any)

    const sql = buildSummarySelectSQL(schema, ['hs_chapter'])
    expect(sql).toContain('"chapter_name"')
    expect(sql).toContain('GROUP BY SUBSTR("hs6_code", 1, 2), "chapter_name"')
  })
})
