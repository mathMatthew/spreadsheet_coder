import { quoteIdent, isValidSqlExpression, type QuerySchema } from './query-builder'
import type { MeasureDefinition } from './model'

// ── Types ────────────────────────────────────────────────────────────

export interface SummaryViewMetadata {
  name: string                 // table name in DuckDB, e.g. "summary_geo"
  dimensions: string[]         // every dimension the view answers, grains and passengers alike
  grains?: string[]            // the grain it was built at; absent on views created before this was recorded
  measures: string[]           // measure IDs included
  datasetName: string          // which dataset this was built from
  createdAt: number
  rowCount: number
}

export interface ViewSelection {
  source: string               // table name to query ('data' or summary view name)
  viewName: string | null      // null when using base data
  viewDimensions?: string[]    // the columns the chosen view carries; absent on base data
}

// ── SQL Generation ───────────────────────────────────────────────────

/**
 * Find the derived dimension a selection entry names, if any.
 *
 * A selection entry is normally a physical column name, but it may also be the
 * id of a derived dimension chosen as a grain in its own right — a view grouped
 * by HS chapter rather than by the six-digit code it is computed from.
 */
export function findDerivedGrain(schema: QuerySchema, entry: string) {
  // A physical column of that name wins: selection entries are column names
  // first, and a derived dimension whose id collides with one would otherwise
  // replace the column with an unrelated expression under the same name.
  if (schema.dimensions.some(d => d.sourceField === entry)) return null

  const dim = schema.dimensions.find(d => d.id === entry)
  if (!dim || !dim.expression || !dim.derivedFromField) return null
  if (!isValidSqlExpression(dim.expression)) return null

  // A dimension whose id is also the column it reads cannot be told apart from
  // that column once materialised, so it stays a passenger as it was before.
  if (dim.id === dim.derivedFromField) return null

  return dim
}

/**
 * Build the SELECT ... GROUP BY query for a summary view (without CREATE TABLE wrapper).
 * Groups by the chosen dimensions, aggregates all eligible measures.
 */
export function buildSummarySelectSQL(
  schema: QuerySchema,
  dimensionFields: string[],
  whereClause?: string
): string {
  const selectParts: string[] = []
  const groupByParts: string[] = []
  const includedFields = new Set(dimensionFields)

  // Derived dimensions chosen as a grain of their own, so the view can stop at
  // a level above the column the expression reads. Recorded here so the
  // ride-along pass below does not emit the same column twice.
  const derivedGrains = new Set<string>()

  // Dimension columns + their descriptionFields
  for (const field of dimensionFields) {
    const derived = findDerivedGrain(schema, field)
    if (derived) {
      derivedGrains.add(derived.id)
      selectParts.push(`${derived.expression} AS ${quoteIdent(derived.id)}`)
      groupByParts.push(derived.expression!)

      // Carry the description column too, or a query joining it reads a column
      // the view does not have
      if (derived.descriptionField && derived.descriptionField !== derived.id) {
        selectParts.push(quoteIdent(derived.descriptionField))
        groupByParts.push(quoteIdent(derived.descriptionField))
      }
      continue
    }

    const dim = schema.dimensions.find(d => d.sourceField === field)
    selectParts.push(quoteIdent(field))
    groupByParts.push(quoteIdent(field))

    if (dim?.descriptionField && dim.descriptionField !== field) {
      selectParts.push(quoteIdent(dim.descriptionField))
      groupByParts.push(quoteIdent(dim.descriptionField))
    }
  }

  // Include derived dimensions whose source column is in the selected dimensions.
  // This pre-computes expressions like YEAR(CAST(...)) so queries against the
  // summary view can use the raw column instead of recomputing on every row.
  for (const dim of schema.dimensions) {
    if (derivedGrains.has(dim.id)) continue
    if (dim.expression && dim.derivedFromField && includedFields.has(dim.derivedFromField)) {
      if (!isValidSqlExpression(dim.expression)) continue
      selectParts.push(`${dim.expression} AS ${quoteIdent(dim.id)}`)
      groupByParts.push(dim.expression)
    }
  }

  // Measures that share a sourceField share one column
  const emitted = new Set<string>()
  for (const m of eligibleMeasures(schema)) {
    if (emitted.has(m.sourceField)) continue
    emitted.add(m.sourceField)
    selectParts.push(`CAST(SUM(${summedExpr(m)}) AS DOUBLE) AS ${quoteIdent(m.sourceField)}`)
  }

  if (selectParts.length === 0) return ''

  const lines = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${quoteIdent('data')}`,
  ]
  if (whereClause) lines.push(`WHERE ${whereClause}`)
  if (groupByParts.length > 0) lines.push(`GROUP BY ${groupByParts.join(', ')}`)
  return lines.join('\n')
}

/**
 * Compute the list of dimension IDs that a summary view covers,
 * including both physical columns and derived dimensions.
 */
export function computeViewDimensions(
  schema: QuerySchema,
  dimensionFields: string[]
): string[] {
  const result = [...dimensionFields]
  const includedFields = new Set(dimensionFields)

  for (const dim of schema.dimensions) {
    if (includedFields.has(dim.id)) continue
    if (dim.expression && dim.derivedFromField && includedFields.has(dim.derivedFromField)) {
      result.push(dim.id)
    }
  }

  return result
}


// ── View Selection ───────────────────────────────────────────────────

/**
 * Find the best summary view for a query, or null if none qualifies.
 *
 * A view qualifies if its dimension set is a superset of all required fields.
 * Derived dimensions count as covered if their source column is in the view
 * (e.g. quarter derived from month — if the view has month, quarter is available).
 * Among qualifying views, we pick the one with the fewest rows.
 */
export function findBestView(
  views: SummaryViewMetadata[],
  requiredFields: Set<string>,
  measureIds: string[],
  schema?: QuerySchema
): SummaryViewMetadata | null {
  // Build a map of derived dim ID → source field for derivability checks
  const derivedToSource = new Map<string, string>()
  if (schema) {
    for (const dim of schema.dimensions) {
      if (dim.expression && dim.derivedFromField) {
        // Map both the dim ID and sourceField (if any) since requiredFields may use either
        derivedToSource.set(dim.id, dim.derivedFromField)
        if (dim.sourceField) derivedToSource.set(dim.sourceField, dim.derivedFromField)
      }
    }
  }

  let best: SummaryViewMetadata | null = null

  for (const view of views) {
    // Recompute effective dimensions using current schema (picks up derived dims
    // added after view creation, as long as their source column is in the view)
    const viewDims = schema
      ? new Set(computeViewDimensions(schema, view.dimensions))
      : new Set(view.dimensions)
    const viewMeasures = new Set(view.measures)

    // Check all required dimension fields are present (directly or via derivation)
    let dimsOk = true
    for (const f of requiredFields) {
      if (viewDims.has(f)) continue
      // Check if f is a derived dim whose source is in the view
      const source = derivedToSource.get(f)
      if (source && viewDims.has(source)) continue
      dimsOk = false
      break
    }
    if (!dimsOk) continue

    // Check all needed measures are present
    let measuresOk = true
    for (const id of measureIds) {
      if (!viewMeasures.has(id)) { measuresOk = false; break }
    }
    if (!measuresOk) continue

    // Pick smallest qualifying view by row count
    if (!best || view.rowCount < best.rowCount) {
      best = view
    }
  }

  return best
}

/**
 * Compute the set of required fields for a query, accounting for
 * dimensions, filters, and stock measure time dimension requirements.
 */
export function computeRequiredFields(
  dimensions: string[],
  filterFields: string[],
  measures: MeasureDefinition[],
  schema: QuerySchema
): Set<string> {
  const required = new Set([...dimensions, ...filterFields])

  // If any measure has non-flow timeAggregation, add time dimensions
  // not already in the requested dimensions
  const hasStockMeasures = measures.some(m => m.timeAggregation && m.timeAggregation !== 'flow')
  if (hasStockMeasures) {
    const dimSet = new Set(dimensions)
    for (const d of schema.dimensions) {
      if (d.isTimeDimension && d.sourceField && !dimSet.has(d.sourceField)) {
        required.add(d.sourceField)
      }
    }
  }

  return required
}

/**
 * Check whether a query should skip summary views entirely.
 * Returns true if any requested measure uses non-SUM aggregation.
 * Only SUM is decomposable for re-aggregation (SUM of SUMs = global SUM).
 */
export function shouldSkipSummaryViews(measures: MeasureDefinition[]): boolean {
  return measures.some(m => (m.aggregation || 'sum') !== 'sum')
}

/**
 * Get eligible measure IDs for summary views (SUM-only).
 */
export function getEligibleMeasureIds(schema: QuerySchema): string[] {
  return eligibleMeasures(schema).map(m => m.id)
}

/**
 * SUM measures, the only aggregation that re-aggregates correctly from a view.
 * A view column is named by the measure's sourceField. Measures sharing a
 * sourceField can share that column only if they sum the same expression;
 * otherwise all of them are left out and queries needing them read the base table.
 */
function eligibleMeasures(schema: QuerySchema): MeasureDefinition[] {
  const sums = schema.measures.filter(m => (m.aggregation || 'sum') === 'sum')
  const exprs = new Map<string, Set<string>>()
  for (const m of sums) {
    if (!exprs.has(m.sourceField)) exprs.set(m.sourceField, new Set())
    exprs.get(m.sourceField)!.add(summedExpr(m))
  }
  return sums.filter(m => exprs.get(m.sourceField)!.size === 1)
}

function summedExpr(m: MeasureDefinition): string {
  return (m.expression && isValidSqlExpression(m.expression)) ? m.expression : quoteIdent(m.sourceField)
}

