import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { QueryBuilder, type RollupResult } from './query-builder'
import { SEP } from './model'
import duckdb from 'duckdb'
import { makeSchema, queryAll, exec, normalize } from './test-helpers'

// ── Reference percentage computation ─────────────────────────────────
//
// Mirrors outline-table.ts formatCellValue exactly.
// This is the TRUSTED oracle: the current client-side logic.

type PctMode = 'pct_row' | 'pct_col' | 'pct_total'

interface CellInfo {
  rowPath: string[]
  colPath: string[]
  metrics: Record<string, number>
  pct: Record<string, number | null>
}

function extractPaths(row: Record<string, any>, rollup: RollupResult) {
  const { groupingColumns, dimensionFields, rowDimensionCount } = rollup
  const rowPath: string[] = []
  for (let i = 0; i < rowDimensionCount; i++) {
    if (Number(row[groupingColumns[i]]) === 0) {
      rowPath.push(String(normalize(row[dimensionFields[i]])))
    } else break
  }
  const colPath: string[] = []
  for (let i = rowDimensionCount; i < dimensionFields.length; i++) {
    if (Number(row[groupingColumns[i]]) === 0) {
      colPath.push(String(normalize(row[dimensionFields[i]])))
    } else break
  }
  return { rowPath, colPath }
}

function pathKey(path: string[]): string {
  return path.join(SEP)
}

/**
 * Compute reference percentages using the same logic as outline-table formatCellValue.
 * Returns one CellInfo per row in the ROLLUP result, with percentage for each metric.
 */
function computeReferencePercentages(
  rows: Record<string, any>[],
  rollup: RollupResult,
  mode: PctMode
): CellInfo[] {
  const { measureFields } = rollup

  // Phase 1: Build totals maps (mirrors parseRollupResult in outline-table)
  const rowSubtotals = new Map<string, Record<string, number>>()
  const colSubtotals = new Map<string, Record<string, number>>()
  let grandTotal: Record<string, number> = {}

  for (const row of rows) {
    const { rowPath, colPath } = extractPaths(row, rollup)
    const metrics: Record<string, number> = {}
    for (const mf of measureFields) metrics[mf] = row[mf] ?? 0

    if (colPath.length === 0) rowSubtotals.set(pathKey(rowPath), { ...metrics })
    if (rowPath.length === 0) colSubtotals.set(pathKey(colPath), { ...metrics })
    if (rowPath.length === 0 && colPath.length === 0) grandTotal = { ...metrics }
  }

  // Phase 2: Compute percentages (mirrors formatCellValue switch logic)
  const result: CellInfo[] = []
  for (const row of rows) {
    const { rowPath, colPath } = extractPaths(row, rollup)
    const metrics: Record<string, number> = {}
    const pct: Record<string, number | null> = {}

    for (const mf of measureFields) {
      const value = row[mf]
      metrics[mf] = value ?? 0

      if (value == null || value === 0) {
        pct[mf] = null
        continue
      }

      let denom: number | undefined
      switch (mode) {
        case 'pct_row': denom = rowSubtotals.get(pathKey(rowPath))?.[mf]; break
        case 'pct_col': denom = colSubtotals.get(pathKey(colPath))?.[mf]; break
        case 'pct_total': denom = grandTotal[mf]; break
      }

      pct[mf] = (!denom || denom === 0) ? null : (value / denom) * 100
    }

    result.push({ rowPath, colPath, metrics, pct })
  }

  return result
}

/** Find a cell by exact row/col path match. */
function findCell(cells: CellInfo[], rowPath: string[], colPath: string[]): CellInfo {
  const match = cells.find(c =>
    c.rowPath.length === rowPath.length &&
    c.colPath.length === colPath.length &&
    c.rowPath.every((v, i) => v === rowPath[i]) &&
    c.colPath.every((v, i) => v === colPath[i])
  )
  if (!match) throw new Error(`No cell: rows=[${rowPath}] cols=[${colPath}]`)
  return match
}

/** Filter to only detail-level cells (all dimensions present, none rolled up). */
function detailCells(cells: CellInfo[], rowCount: number, colCount: number): CellInfo[] {
  return cells.filter(c => c.rowPath.length === rowCount && c.colPath.length === colCount)
}

// ── Test data ────────────────────────────────────────────────────────
//
// Cross-tab: 2 regions × 2 products × 2 channels × 2 sub_channels.
// Every combination present → clean cross-tabulation (no hierarchy nesting).
//
//   region | product | channel | sub_channel | revenue
//   East   | A       | Direct  | Web         | 100
//   East   | A       | Direct  | App         | 60
//   East   | A       | Partner | Retail      | 200
//   East   | A       | Partner | Wholesale   | 80
//   East   | B       | Direct  | Web         | 150
//   East   | B       | Direct  | App         | 40
//   East   | B       | Partner | Retail      | 100
//   East   | B       | Partner | Wholesale   | 90
//   West   | A       | Direct  | Web         | 50
//   West   | A       | Direct  | App         | 30
//   West   | A       | Partner | Retail      | 75
//   West   | A       | Partner | Wholesale   | 45
//   West   | B       | Direct  | Web         | 80
//   West   | B       | Direct  | App         | 20
//   West   | B       | Partner | Retail      | 120
//   West   | B       | Partner | Wholesale   | 60
//
// Row totals (region × product):
//   East|A=440, East|B=380, West|A=200, West|B=280
//   East=820, West=480, Grand=1300
//
// Column totals (channel):
//   Direct=530, Partner=770
//
// Column totals (channel × sub_channel):
//   Direct|Web=380, Direct|App=150, Partner|Retail=495, Partner|Wholesale=275
//   Direct=530, Partner=770

describe('Percentage display modes', () => {
  let db: any
  let conn: any

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE sales (
        region VARCHAR, product VARCHAR,
        channel VARCHAR, sub_channel VARCHAR,
        revenue DOUBLE
      );
      INSERT INTO sales VALUES
        ('East', 'A', 'Direct',  'Web',        100),
        ('East', 'A', 'Direct',  'App',         60),
        ('East', 'A', 'Partner', 'Retail',      200),
        ('East', 'A', 'Partner', 'Wholesale',    80),
        ('East', 'B', 'Direct',  'Web',        150),
        ('East', 'B', 'Direct',  'App',         40),
        ('East', 'B', 'Partner', 'Retail',      100),
        ('East', 'B', 'Partner', 'Wholesale',    90),
        ('West', 'A', 'Direct',  'Web',         50),
        ('West', 'A', 'Direct',  'App',         30),
        ('West', 'A', 'Partner', 'Retail',       75),
        ('West', 'A', 'Partner', 'Wholesale',    45),
        ('West', 'B', 'Direct',  'Web',         80),
        ('West', 'B', 'Direct',  'App',         20),
        ('West', 'B', 'Partner', 'Retail',      120),
        ('West', 'B', 'Partner', 'Wholesale',    60);
    `)
  })

  afterAll(() => { db?.close() })

  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
      { id: 'product', sourceField: 'product' },
      { id: 'channel', sourceField: 'channel' },
      { id: 'sub_channel', sourceField: 'sub_channel' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
    ],
  })

  async function runWithPct(opts: {
    rowDimensions: string[]
    columnDimensions?: string[]
    mode: PctMode
  }) {
    const qb = new QueryBuilder(schema)
    const rollup = qb.buildRollupAggregation({
      rowDimensions: opts.rowDimensions,
      columnDimensions: opts.columnDimensions,
      measures: ['revenue'],
      source: 'sales',
    })
    const rows = await queryAll(conn, rollup.sql)
    const cells = computeReferencePercentages(rows, rollup, opts.mode)
    return { rollup, rows, cells }
  }

  // ── Config 1: [region, product] rows × [channel] col ──────────────

  describe('[region, product] rows × [channel] col', () => {

    it('pct_row: detail cells in same row sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode: 'pct_row',
      })

      // East|A across channels: Direct(160) + Partner(280) = 440
      const d = findCell(cells, ['East', 'A'], ['Direct'])
      const p = findCell(cells, ['East', 'A'], ['Partner'])
      expect(d.pct.revenue! + p.pct.revenue!).toBeCloseTo(100, 4)

      // Spot: East|A|Direct = 160/440 = 36.36%
      expect(d.pct.revenue).toBeCloseTo(160 / 440 * 100, 4)

      // Row total cells should be 100%
      expect(findCell(cells, ['East', 'A'], []).pct.revenue).toBeCloseTo(100, 4)
      expect(findCell(cells, ['West', 'B'], []).pct.revenue).toBeCloseTo(100, 4)
    })

    it('pct_row: region subtotal level', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode: 'pct_row',
      })

      // East × Direct = (160+190) = 350, East total = 820
      const east_d = findCell(cells, ['East'], ['Direct'])
      expect(east_d.pct.revenue).toBeCloseTo(350 / 820 * 100, 4)

      // East × Partner = (280+190) = 470, 470/820
      const east_p = findCell(cells, ['East'], ['Partner'])
      expect(east_d.pct.revenue! + east_p.pct.revenue!).toBeCloseTo(100, 4)
    })

    it('pct_col: detail cells in same column sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode: 'pct_col',
      })

      // Direct column = 530
      const detail = detailCells(cells, 2, 1).filter(c => c.colPath[0] === 'Direct')
      const sum = detail.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)

      // Spot: East|A|Direct = 160/530
      expect(findCell(cells, ['East', 'A'], ['Direct']).pct.revenue)
        .toBeCloseTo(160 / 530 * 100, 4)
    })

    it('pct_col: column total cells should be 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode: 'pct_col',
      })

      // Column subtotal row (all rows rolled up) for Direct
      expect(findCell(cells, [], ['Direct']).pct.revenue).toBeCloseTo(100, 4)
      expect(findCell(cells, [], ['Partner']).pct.revenue).toBeCloseTo(100, 4)
    })

    it('pct_total: all detail cells sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode: 'pct_total',
      })

      const detail = detailCells(cells, 2, 1)
      const sum = detail.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)

      // Grand total = 100%
      expect(findCell(cells, [], []).pct.revenue).toBeCloseTo(100, 4)

      // Spot: East|A|Direct = 160/1300
      expect(findCell(cells, ['East', 'A'], ['Direct']).pct.revenue)
        .toBeCloseTo(160 / 1300 * 100, 4)
    })
  })

  // ── Config 2: [product] rows × [channel, sub_channel] cols ────────

  describe('[product] rows × [channel, sub_channel] cols', () => {

    it('pct_row: detail cells in same row sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_row',
      })

      // Product A total = 440 (across all channels/sub_channels)
      // A × Direct|Web = 150, A × Direct|App = 90, A × Partner|Retail = 275, A × Partner|Wholesale = 125
      // Wait, let me recalculate. Product A across both regions:
      // Direct|Web: 100+50=150, Direct|App: 60+30=90
      // Partner|Retail: 200+75=275, Partner|Wholesale: 80+45=125
      // Total A = 150+90+275+125 = 640

      // Product B:
      // Direct|Web: 150+80=230, Direct|App: 40+20=60
      // Partner|Retail: 100+120=220, Partner|Wholesale: 90+60=150
      // Total B = 230+60+220+150 = 660

      const detail_A = detailCells(cells, 1, 2).filter(c => c.rowPath[0] === 'A')
      const sum_A = detail_A.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum_A).toBeCloseTo(100, 2)

      // Spot: A × Direct|Web = 150/640
      expect(findCell(cells, ['A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(150 / 640 * 100, 4)
    })

    it('pct_row: no intermediate column subtotals with GROUPING SETS', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_row',
      })

      // GROUPING SETS((channel, sub_channel), ()) means no channel-level
      // subtotals (sub_channel rolled up). Only leaf columns and row totals.
      const channelOnly = cells.filter(c => c.colPath.length === 1)
      expect(channelOnly).toHaveLength(0)

      // Detail cells still have correct pct_row
      // A × Direct|Web = 150, A total = 640
      expect(findCell(cells, ['A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(150 / 640 * 100, 4)
    })

    it('pct_col: detail cells in same column sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_col',
      })

      // Direct|Web column total = 380 (all products)
      // A × Direct|Web = 150/380, B × Direct|Web = 230/380
      const a_dw = findCell(cells, ['A'], ['Direct', 'Web']).pct.revenue!
      const b_dw = findCell(cells, ['B'], ['Direct', 'Web']).pct.revenue!
      expect(a_dw + b_dw).toBeCloseTo(100, 4)

      expect(a_dw).toBeCloseTo(150 / 380 * 100, 4)
    })

    it('pct_total: grand total is 100%, detail sums to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_total',
      })

      // Grand = 1300
      expect(findCell(cells, [], []).pct.revenue).toBeCloseTo(100, 4)

      const detail = detailCells(cells, 1, 2)
      const sum = detail.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)
    })
  })

  // ── Config 3: [region, product] rows × [channel, sub_channel] cols ─

  describe('[region, product] rows × [channel, sub_channel] cols', () => {

    it('pct_row: detail cells in same row sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_row',
      })

      // East|A total = 440
      const detail_EA = detailCells(cells, 2, 2).filter(
        c => c.rowPath[0] === 'East' && c.rowPath[1] === 'A'
      )
      expect(detail_EA).toHaveLength(4)
      const sum = detail_EA.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)

      // Spot: East|A × Direct|Web = 100/440
      expect(findCell(cells, ['East', 'A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(100 / 440 * 100, 4)
    })

    it('pct_row: region subtotal × row total', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_row',
      })

      // East × row total should be 100%
      expect(findCell(cells, ['East'], []).pct.revenue).toBeCloseTo(100, 4)

      // East × detail column: East|A Direct|Web = 100, East total = 820
      expect(findCell(cells, ['East', 'A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(100 / 440 * 100, 4)
    })

    it('pct_col: detail cells in same column sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_col',
      })

      // Direct|Web total = 380
      const col_dw = detailCells(cells, 2, 2).filter(
        c => c.colPath[0] === 'Direct' && c.colPath[1] === 'Web'
      )
      expect(col_dw).toHaveLength(4)
      const sum = col_dw.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)

      // Spot: East|A × Direct|Web = 100/380
      expect(findCell(cells, ['East', 'A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(100 / 380 * 100, 4)

      // Column total cells should be 100%
      expect(findCell(cells, [], ['Direct', 'Web']).pct.revenue).toBeCloseTo(100, 4)
    })

    it('pct_col: row subtotal in column', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_col',
      })

      // East × Direct|Web = 100+150 = 250, column total Direct|Web = 380
      expect(findCell(cells, ['East'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(250 / 380 * 100, 4)
    })

    it('pct_total: all detail cells sum to 100%', async () => {
      const { cells } = await runWithPct({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode: 'pct_total',
      })

      const detail = detailCells(cells, 2, 2)
      expect(detail).toHaveLength(16) // 2×2×2×2
      const sum = detail.reduce((s, c) => s + (c.pct.revenue ?? 0), 0)
      expect(sum).toBeCloseTo(100, 2)

      // Grand total = 100%
      expect(findCell(cells, [], []).pct.revenue).toBeCloseTo(100, 4)

      // Spot: East|A × Direct|Web = 100/1300
      expect(findCell(cells, ['East', 'A'], ['Direct', 'Web']).pct.revenue)
        .toBeCloseTo(100 / 1300 * 100, 4)

      // Row subtotal: East × row total = 820/1300
      expect(findCell(cells, ['East'], []).pct.revenue)
        .toBeCloseTo(820 / 1300 * 100, 4)
    })

    it('all percentages are between 0 and 100 for non-null values', async () => {
      for (const mode of ['pct_row', 'pct_col', 'pct_total'] as const) {
        const { cells } = await runWithPct({
          rowDimensions: ['region', 'product'],
          columnDimensions: ['channel', 'sub_channel'],
          mode,
        })
        for (const cell of cells) {
          const p = cell.pct.revenue
          if (p != null) {
            expect(p).toBeGreaterThanOrEqual(0)
            expect(p).toBeLessThanOrEqual(100.001)
          }
        }
      }
    })
  })

  // ── Config 4: [region] rows × [product] cols (simple 1×1) ────────

  describe('[region] rows × [product] cols', () => {

    it('pct_row + pct_col + pct_total spot checks', async () => {
      // East total: East|A(440) + East|B(380) = 820
      // Product A total: East|A(440) + West|A(200) = 640
      // Grand = 1300

      // pct_row: East|A = 440/820
      const { cells: pctRow } = await runWithPct({
        rowDimensions: ['region'],
        columnDimensions: ['product'],
        mode: 'pct_row',
      })
      expect(findCell(pctRow, ['East'], ['A']).pct.revenue)
        .toBeCloseTo(440 / 820 * 100, 4)
      expect(findCell(pctRow, ['East'], ['B']).pct.revenue)
        .toBeCloseTo(380 / 820 * 100, 4)

      // pct_col: East|A = 440/640
      const { cells: pctCol } = await runWithPct({
        rowDimensions: ['region'],
        columnDimensions: ['product'],
        mode: 'pct_col',
      })
      expect(findCell(pctCol, ['East'], ['A']).pct.revenue)
        .toBeCloseTo(440 / 640 * 100, 4)
      expect(findCell(pctCol, ['West'], ['A']).pct.revenue)
        .toBeCloseTo(200 / 640 * 100, 4)

      // pct_total: East|A = 440/1300
      const { cells: pctTotal } = await runWithPct({
        rowDimensions: ['region'],
        columnDimensions: ['product'],
        mode: 'pct_total',
      })
      expect(findCell(pctTotal, ['East'], ['A']).pct.revenue)
        .toBeCloseTo(440 / 1300 * 100, 4)
    })
  })

  // ── SQL comparison tests ──────────────────────────────────────────
  //
  // These verify that QueryBuilder's SQL-based percentage columns match
  // the reference computation exactly. Enable after implementing
  // displayMode in buildRollupAggregation.
  //
  // Expected API:
  //   qb.buildRollupAggregation({ ...opts, displayMode: 'pct_row' })
  //   → RollupResult with additional percentageFields: ['revenue_pct']
  //   → SQL output has 'revenue_pct' column for each measure

  describe('SQL percentages match reference', () => {

    async function compareSQL(config: {
      rowDimensions: string[]
      columnDimensions?: string[]
      mode: PctMode
    }) {
      const qb = new QueryBuilder(schema)

      // Reference: base query + client-side computation
      const baseRollup = qb.buildRollupAggregation({
        rowDimensions: config.rowDimensions,
        columnDimensions: config.columnDimensions,
        measures: ['revenue'],
        source: 'sales',
      })
      const baseRows = await queryAll(conn, baseRollup.sql)
      const reference = computeReferencePercentages(baseRows, baseRollup, config.mode)

      // SQL: query with displayMode
      const pctRollup = qb.buildRollupAggregation({
        rowDimensions: config.rowDimensions,
        columnDimensions: config.columnDimensions,
        measures: ['revenue'],
        source: 'sales',
        displayMode: config.mode,
      })
      const pctRows = await queryAll(conn, pctRollup.sql)

      // Same number of rows
      expect(pctRows.length).toBe(baseRows.length)

      // Each row's SQL percentage matches the reference
      for (let i = 0; i < pctRows.length; i++) {
        const refPct = reference[i].pct.revenue
        const sqlPct = pctRows[i].revenue_pct

        if (refPct == null) {
          expect(sqlPct == null || sqlPct === 0 || Number.isNaN(sqlPct)).toBe(true)
        } else {
          expect(sqlPct).toBeCloseTo(refPct, 4)
        }
      }
    }

    for (const mode of ['pct_row', 'pct_col', 'pct_total'] as const) {
      it(`${mode}: 2 rows + 1 col`, () => compareSQL({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel'],
        mode,
      }))

      it(`${mode}: 1 row + 2 cols`, () => compareSQL({
        rowDimensions: ['product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode,
      }))

      it(`${mode}: 2 rows + 2 cols`, () => compareSQL({
        rowDimensions: ['region', 'product'],
        columnDimensions: ['channel', 'sub_channel'],
        mode,
      }))

      it(`${mode}: 1 row + 1 col`, () => compareSQL({
        rowDimensions: ['region'],
        columnDimensions: ['product'],
        mode,
      }))
    }
  })
})

// ── Stock measures: two-pass rollup path ─────────────────────────────
//
// Uses the unequal-coverage dataset to exercise the two-pass rollup.
// Percentage logic is the same, but SQL generation differs (CTE + UNION ALL).

describe('Percentage with stock measures (two-pass)', () => {
  let db: any
  let conn: any

  const AX_WAVG = 13350 / 90
  const AY_WAVG = 5650 / 90
  const BX_WAVG = 20500 / 59
  const BY_WAVG = 32300 / 59
  const A_TOTAL = AX_WAVG + AY_WAVG   // 19000/90 = 211.111...
  const B_TOTAL = BX_WAVG + BY_WAVG   // 52800/59 = 894.915...
  const GRAND = A_TOTAL + B_TOTAL      // 1106.027...

  beforeAll(async () => {
    db = new duckdb.Database(':memory:')
    conn = db.connect()
    await exec(conn, `
      CREATE TABLE uneq (
        entity VARCHAR, category VARCHAR, month DATE, value DOUBLE
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

  const stockSchema = makeSchema({
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

  async function runStockPct(opts: {
    rowDimensions: string[]
    columnDimensions?: string[]
    mode: PctMode
  }) {
    const qb = new QueryBuilder(stockSchema)
    const rollup = qb.buildRollupAggregation({
      rowDimensions: opts.rowDimensions,
      columnDimensions: opts.columnDimensions,
      measures: ['value'],
      source: 'uneq',
    })
    const rows = await queryAll(conn, rollup.sql)
    const cells = computeReferencePercentages(rows, rollup, opts.mode)
    return { rollup, rows, cells }
  }

  // ── [entity, category] rows, no columns (two-pass, hidden time dim) ──

  describe('[entity, category] rows, no columns', () => {

    it('pct_total: matches expected weighted-avg percentages', async () => {
      const { cells } = await runStockPct({
        rowDimensions: ['entity', 'category'],
        mode: 'pct_total',
      })

      // A|X weighted avg = 13350/90, grand = A_TOTAL + B_TOTAL
      expect(findCell(cells, ['A', 'X'], []).pct.value)
        .toBeCloseTo(AX_WAVG / GRAND * 100, 2)

      expect(findCell(cells, ['B', 'Y'], []).pct.value)
        .toBeCloseTo(BY_WAVG / GRAND * 100, 2)

      // Entity subtotals
      expect(findCell(cells, ['A'], []).pct.value)
        .toBeCloseTo(A_TOTAL / GRAND * 100, 2)

      // Grand = 100%
      expect(findCell(cells, [], []).pct.value).toBeCloseTo(100, 2)
    })

    it('pct_row: no columns means every cell = 100% of its own row', async () => {
      const { cells } = await runStockPct({
        rowDimensions: ['entity', 'category'],
        mode: 'pct_row',
      })

      // Without columns, each cell IS the row total, so pct_row is always 100%
      expect(findCell(cells, ['A', 'X'], []).pct.value).toBeCloseTo(100, 2)
      expect(findCell(cells, ['A', 'Y'], []).pct.value).toBeCloseTo(100, 2)
      expect(findCell(cells, ['B', 'X'], []).pct.value).toBeCloseTo(100, 2)
      expect(findCell(cells, ['A'], []).pct.value).toBeCloseTo(100, 2)
      expect(findCell(cells, [], []).pct.value).toBeCloseTo(100, 2)
    })
  })

  // ── [entity] rows × [category] cols (two-pass, category not time-derived) ──

  describe('[entity] rows × [category] cols', () => {

    it('pct_row: entity breakdown across categories', async () => {
      const { cells } = await runStockPct({
        rowDimensions: ['entity'],
        columnDimensions: ['category'],
        mode: 'pct_row',
      })

      // A × X as % of A total
      expect(findCell(cells, ['A'], ['X']).pct.value)
        .toBeCloseTo(AX_WAVG / A_TOTAL * 100, 2)

      // B × Y as % of B total
      expect(findCell(cells, ['B'], ['Y']).pct.value)
        .toBeCloseTo(BY_WAVG / B_TOTAL * 100, 2)
    })

    it('pct_col: category breakdown across entities', async () => {
      const { cells } = await runStockPct({
        rowDimensions: ['entity'],
        columnDimensions: ['category'],
        mode: 'pct_col',
      })

      // X column total = AX_WAVG + BX_WAVG
      const xTotal = AX_WAVG + BX_WAVG
      expect(findCell(cells, ['A'], ['X']).pct.value)
        .toBeCloseTo(AX_WAVG / xTotal * 100, 2)

      // Entity subtotals in same column should sum to 100%
      const a_x = findCell(cells, ['A'], ['X']).pct.value!
      const b_x = findCell(cells, ['B'], ['X']).pct.value!
      expect(a_x + b_x).toBeCloseTo(100, 2)
    })
  })

  // ── SQL comparison for stock measures ──────────────────────────────

  describe('SQL percentages match reference (stock)', () => {

    async function compareStockSQL(config: {
      rowDimensions: string[]
      columnDimensions?: string[]
      mode: PctMode
    }) {
      const qb = new QueryBuilder(stockSchema)

      const baseRollup = qb.buildRollupAggregation({
        rowDimensions: config.rowDimensions,
        columnDimensions: config.columnDimensions,
        measures: ['value'],
        source: 'uneq',
      })
      const baseRows = await queryAll(conn, baseRollup.sql)
      const reference = computeReferencePercentages(baseRows, baseRollup, config.mode)

      const pctRollup = qb.buildRollupAggregation({
        rowDimensions: config.rowDimensions,
        columnDimensions: config.columnDimensions,
        measures: ['value'],
        source: 'uneq',
        displayMode: config.mode,
      })
      const pctRows = await queryAll(conn, pctRollup.sql)

      expect(pctRows.length).toBe(baseRows.length)
      for (let i = 0; i < pctRows.length; i++) {
        const refPct = reference[i].pct.value
        const sqlPct = pctRows[i].value_pct

        if (refPct == null) {
          expect(sqlPct == null || sqlPct === 0 || Number.isNaN(sqlPct)).toBe(true)
        } else {
          expect(sqlPct).toBeCloseTo(refPct, 2)
        }
      }
    }

    for (const mode of ['pct_row', 'pct_col', 'pct_total'] as const) {
      it(`${mode}: [entity, category] rows (two-pass)`, () => compareStockSQL({
        rowDimensions: ['entity', 'category'],
        mode,
      }))

      it(`${mode}: [entity] rows × [category] cols (two-pass)`, () => compareStockSQL({
        rowDimensions: ['entity'],
        columnDimensions: ['category'],
        mode,
      }))
    }
  })
})
