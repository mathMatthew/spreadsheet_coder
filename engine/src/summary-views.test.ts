import { describe, it, expect } from 'vitest'


import {
  findBestView,
  computeRequiredFields,
  shouldSkipSummaryViews,
  buildSummarySelectSQL,
  getEligibleMeasureIds,
  type SummaryViewMetadata
} from './summary-views'
import { QueryBuilder, type QuerySchema } from './query-builder'
import type { DimensionDefinition, MeasureDefinition } from './model'

// ── Helpers ──────────────────────────────────────────────────────────

function makeSchema(overrides: {
  dimensions?: Partial<DimensionDefinition>[]
  measures?: Partial<MeasureDefinition>[]
}): QuerySchema {
  const dimensions: DimensionDefinition[] = (overrides.dimensions ?? []).map((d, i) => ({
    id: d.id ?? `dim_${i}`,
    displayName: d.displayName ?? d.id ?? `Dim ${i}`,
    sourceField: d.sourceField ?? d.id ?? `dim_${i}`,
    ...d
  } as DimensionDefinition))

  const measures: MeasureDefinition[] = (overrides.measures ?? []).map((m, i) => ({
    id: m.id ?? `measure_${i}`,
    displayName: m.displayName ?? m.id ?? `Measure ${i}`,
    sourceField: m.sourceField ?? m.id ?? `measure_${i}`,
    ...m
  } as MeasureDefinition))

  return { dimensions, measures, hierarchies: [] }
}

function makeView(name: string, dims: string[], measures: string[], rowCount = 100): SummaryViewMetadata {
  return {
    name,
    dimensions: dims,
    measures,
    datasetName: 'test.parquet',
    createdAt: Date.now(),
    rowCount
  }
}

// ── findBestView ─────────────────────────────────────────────────────

describe('findBestView', () => {
  const measures = ['revenue', 'units']

  it('returns null when no views exist', () => {
    expect(findBestView([], new Set(['region']), measures)).toBeNull()
  })

  it('returns null when no view covers required fields', () => {
    const views = [makeView('v1', ['region'], measures)]
    expect(findBestView(views, new Set(['region', 'channel']), measures)).toBeNull()
  })

  it('selects a view that covers all required fields', () => {
    const views = [makeView('v1', ['region', 'channel'], measures)]
    const result = findBestView(views, new Set(['region']), measures)
    expect(result?.name).toBe('v1')
  })

  it('picks the qualifying view with fewest rows', () => {
    const views = [
      makeView('big', ['region', 'channel'], measures, 5000),
      makeView('small', ['region', 'channel', 'product'], measures, 200),
    ]
    const result = findBestView(views, new Set(['region']), measures)
    expect(result?.name).toBe('small')
  })

  it('skips views missing required measures', () => {
    const views = [makeView('v1', ['region', 'channel'], ['revenue'])]  // missing 'units'
    expect(findBestView(views, new Set(['region']), ['revenue', 'units'])).toBeNull()
  })

  it('any view satisfies an empty required fields set (grand total)', () => {
    const views = [
      makeView('big', ['region', 'channel'], measures, 5000),
      makeView('small', ['region'], measures, 200),
    ]
    const result = findBestView(views, new Set(), measures)
    expect(result?.name).toBe('small')
  })

  it('exact match preferred over superset when fewer rows', () => {
    const views = [
      makeView('super', ['region', 'channel', 'product'], measures, 10000),
      makeView('exact', ['region', 'channel'], measures, 500),
    ]
    const result = findBestView(views, new Set(['region', 'channel']), measures)
    expect(result?.name).toBe('exact')
  })
})

// ── computeRequiredFields ────────────────────────────────────────────

describe('computeRequiredFields', () => {
  it('includes dimensions and filter fields', () => {
    const schema = makeSchema({ dimensions: [], measures: [] })
    const measures: MeasureDefinition[] = []
    const result = computeRequiredFields(['region'], ['channel'], measures, schema)
    expect(result).toEqual(new Set(['region', 'channel']))
  })

  it('adds time dimensions for stock measures', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'month', sourceField: 'month', isTimeDimension: true },
      ],
      measures: [
        { id: 'hc', sourceField: 'hc', timeAggregation: 'weighted_avg' },
      ],
    })
    // Query requests 'dept' only — but stock measure needs time dim
    const result = computeRequiredFields(['dept'], [], schema.measures, schema)
    expect(result).toEqual(new Set(['dept', 'month']))
  })

  it('does not add time dims for flow-only measures', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
        { id: 'month', sourceField: 'month', isTimeDimension: true },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })
    const result = computeRequiredFields(['dept'], [], schema.measures, schema)
    expect(result).toEqual(new Set(['dept']))
  })

  it('does not duplicate time dims already in requested dimensions', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'month', sourceField: 'month', isTimeDimension: true },
      ],
      measures: [
        { id: 'hc', sourceField: 'hc', timeAggregation: 'eop' },
      ],
    })
    const result = computeRequiredFields(['month'], [], schema.measures, schema)
    expect(result).toEqual(new Set(['month']))
  })
})

// ── shouldSkipSummaryViews ───────────────────────────────────────────

describe('shouldSkipSummaryViews', () => {
  it('returns true when any measure is AVG', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a', aggregation: 'sum' as const },
      { id: 'b', displayName: 'B', sourceField: 'b', aggregation: 'avg' as const },
    ]
    expect(shouldSkipSummaryViews(measures)).toBe(true)
  })

  it('returns true when any measure is MAX', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a', aggregation: 'sum' as const },
      { id: 'b', displayName: 'B', sourceField: 'b', aggregation: 'max' as const },
    ]
    expect(shouldSkipSummaryViews(measures)).toBe(true)
  })

  it('returns true when any measure is MIN', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a', aggregation: 'min' as const },
    ]
    expect(shouldSkipSummaryViews(measures)).toBe(true)
  })

  it('returns true when any measure is COUNT', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a', aggregation: 'count' as const },
    ]
    expect(shouldSkipSummaryViews(measures)).toBe(true)
  })

  it('returns false for SUM-only measures', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a', aggregation: 'sum' as const },
      { id: 'b', displayName: 'B', sourceField: 'b', aggregation: 'sum' as const },
    ]
    expect(shouldSkipSummaryViews(measures)).toBe(false)
  })

  it('returns false when aggregation is undefined (defaults to sum)', () => {
    const measures = [
      { id: 'a', displayName: 'A', sourceField: 'a' },
    ] as MeasureDefinition[]
    expect(shouldSkipSummaryViews(measures)).toBe(false)
  })
})

// ── buildSummarySelectSQL ────────────────────────────────────────────

describe('buildSummarySelectSQL', () => {
  it('generates correct SQL for SUM measures, columns named by sourceField', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
        { id: 'channel', sourceField: 'channel' },
      ],
      measures: [
        { id: 'revenue_total', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    const sql = buildSummarySelectSQL(schema, ['region', 'channel'])
    // Column named by sourceField, not measure id
    expect(sql).toContain('AS "revenue"')
    expect(sql).not.toContain('"revenue_total"')
    // Should be a SELECT, not CREATE TABLE
    expect(sql).not.toContain('CREATE')
    expect(sql).toMatchSnapshot()
  })

  it('excludes non-SUM measures (MAX, MIN, COUNT, AVG)', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'dept', sourceField: 'dept' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        { id: 'avg_price', sourceField: 'price', aggregation: 'avg' },
        { id: 'max_qty', sourceField: 'qty', aggregation: 'max' },
        { id: 'row_count', sourceField: 'id', aggregation: 'count' },
      ],
    })

    const sql = buildSummarySelectSQL(schema, ['dept'])
    expect(sql).toContain('"revenue"')
    expect(sql).not.toContain('AVG')
    expect(sql).not.toContain('MAX')
    expect(sql).not.toContain('COUNT')
    expect(sql).toMatchSnapshot()
  })

  it('includes descriptionField columns', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region', descriptionField: 'region_name' },
      ],
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
      ],
    })

    const sql = buildSummarySelectSQL(schema, ['region'])
    expect(sql).toContain('"region_name"')
    expect(sql).toMatchSnapshot()
  })

  it('uses expression for aggregation input when present', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
      ],
      measures: [
        { id: 'line_total', sourceField: 'line_total', expression: 'unit_price * quantity', aggregation: 'sum' },
      ],
    })

    const sql = buildSummarySelectSQL(schema, ['region'])
    // Aggregation uses the expression
    expect(sql).toContain('SUM(unit_price * quantity)')
    // Column named by sourceField
    expect(sql).toContain('AS "line_total"')
    expect(sql).toMatchSnapshot()
  })
})

// ── QueryBuilder source parameter ────────────────────────────────────

describe('QueryBuilder with source parameter', () => {
  const schema = makeSchema({
    dimensions: [
      { id: 'region', sourceField: 'region' },
    ],
    measures: [
      { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
    ],
  })

  it('defaults to FROM "data"', () => {
    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue' }],
    })
    expect(sql).toContain('FROM "data"')
  })

  it('uses custom source in buildAggregation', () => {
    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'revenue' }],
      source: 'summary_geo',
    })
    expect(sql).toContain('FROM "summary_geo"')
    expect(sql).not.toContain('FROM "data"')
  })

  it('uses custom source in buildRollupAggregation', () => {
    const qb = new QueryBuilder(schema)
    const { sql } = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['revenue'],
      source: 'summary_geo',
    })
    expect(sql).toContain('FROM "summary_geo"')
    expect(sql).not.toContain('FROM "data"')
  })
})

// ── QueryBuilder preAggregated flag ──────────────────────────────────

describe('QueryBuilder with preAggregated flag', () => {
  it('uses sourceField instead of expression when preAggregated', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
      ],
      measures: [
        { id: 'line_total', sourceField: 'line_total', expression: 'unit_price * quantity', aggregation: 'sum' },
      ],
    })
    const qb = new QueryBuilder(schema)

    // Without preAggregated: uses expression
    const normal = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'line_total' }],
    })
    expect(normal.sql).toContain('SUM(unit_price * quantity)')

    // With preAggregated: uses sourceField column
    const preAgg = qb.buildAggregation({
      dimensions: ['region'],
      values: [{ field: 'line_total' }],
      source: 'summary_view',
      preAggregated: true,
    })
    expect(preAgg.sql).toContain('SUM("line_total")')
    expect(preAgg.sql).not.toContain('unit_price * quantity')
  })

  it('uses sourceField in rollup when preAggregated', () => {
    const schema = makeSchema({
      dimensions: [
        { id: 'region', sourceField: 'region' },
      ],
      measures: [
        { id: 'line_total', sourceField: 'line_total', expression: 'unit_price * quantity', aggregation: 'sum' },
      ],
    })
    const qb = new QueryBuilder(schema)

    const preAgg = qb.buildRollupAggregation({
      rowDimensions: ['region'],
      measures: ['line_total'],
      source: 'summary_view',
      preAggregated: true,
    })
    expect(preAgg.sql).toContain('SUM("line_total")')
    expect(preAgg.sql).not.toContain('unit_price * quantity')
  })
})

// ── getEligibleMeasureIds ────────────────────────────────────────────

describe('getEligibleMeasureIds', () => {
  it('includes only SUM measures', () => {
    const schema = makeSchema({
      measures: [
        { id: 'revenue', sourceField: 'revenue', aggregation: 'sum' },
        { id: 'avg_price', sourceField: 'price', aggregation: 'avg' },
        { id: 'max_qty', sourceField: 'qty', aggregation: 'max' },
        { id: 'units', sourceField: 'units' },  // default = sum
      ],
    })
    expect(getEligibleMeasureIds(schema)).toEqual(['revenue', 'units'])
  })
})
