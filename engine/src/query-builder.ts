import type { Filter, PivotValue, ReportSort, DimensionDefinition, MeasureDefinition, HierarchyConfig, TimeDimensionConfig, FlowDeclaration, FormatConfig } from './model'

/** Row cap for flat aggregation queries when the caller gives no limit. */
export const DEFAULT_MAX_ROWS = 2000

/** Double-quote a SQL identifier, escaping embedded quotes. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"'
}

/**
 * Validate a SQL expression for safety before interpolation.
 * Rejects expressions containing semicolons, comments, or dangerous SQL keywords.
 * Used for sortExpression, expression, and parseExpression fields from schema JSON.
 *
 * This is a defense-in-depth blocklist — the primary trust boundary is that schema
 * JSON is authored locally. If schemas are ever shared or URL-imported, this should
 * be replaced with a proper allowlist parser.
 */
export function isValidSqlExpression(expr: string): boolean {
  if (!expr || !expr.trim()) return false
  if (expr.includes(';')) return false
  if (expr.includes('--') || expr.includes('/*')) return false
  const upper = expr.toUpperCase()
  const dangerous = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|EXEC|TRUNCATE|GRANT|REVOKE|COPY|ATTACH|LOAD|CALL|PRAGMA|UNION)\b/
  if (dangerous.test(upper)) return false
  return true
}

/**
 * Resolve a dimension id/sourceField to the SQL expression that produces its
 * values against the BASE data table: the dimension's expression for derived
 * dimensions (core_status, card_book, …), the quoted column otherwise.
 * Anything that builds its own SQL against base data (value picker, etc.)
 * must use this — quoting the dimension id directly binds nothing for
 * expression dimensions.
 */
export function resolveDimExprForSchema(
  schema: { dimensions: DimensionDefinition[] },
  dim: string
): string {
  const def = schema.dimensions.find(d => d.sourceField === dim)
            || schema.dimensions.find(d => d.id === dim)
  const expr = def?.expression && isValidSqlExpression(def.expression) ? def.expression : null
  return expr || quoteIdent(dim)
}


/**
 * Expand $DIMS(dimId, ...) in a derived expression to a quoted, comma-separated
 * list of all query dimensions except the named ones. This lets comparison
 * formulas auto-partition by the correct dimensions regardless of the view.
 *
 * Examples:
 *   $DIMS(year)          with [dept, year]          → "dept"
 *   $DIMS(year, quarter) with [dept, year, quarter] → "dept"
 */
/**
 * Inject grouping columns into OVER() clauses so window functions partition
 * by grouping level. This prevents subtotal rows from mixing with leaf rows
 * in window computations.
 *
 * Handles three patterns:
 *   OVER (PARTITION BY X ORDER BY Y) → OVER (PARTITION BY gcols, X ORDER BY Y)
 *   OVER (ORDER BY Y)                → OVER (PARTITION BY gcols ORDER BY Y)
 *   OVER ()                          → OVER (PARTITION BY gcols)
 */
export function injectGroupingPartition(expression: string, groupingCols: string[]): string {
  if (groupingCols.length === 0) return expression
  const prefix = groupingCols.map(c => quoteIdent(c)).join(', ')
  // Apply in order: PARTITION BY first (most specific), then ORDER BY, then empty OVER()
  return expression
    .replace(/\bOVER\s*\(\s*PARTITION\s+BY\s+/gi, `OVER (PARTITION BY ${prefix}, `)
    .replace(/\bOVER\s*\(\s*ORDER\s+BY\s+/gi, `OVER (PARTITION BY ${prefix} ORDER BY `)
    .replace(/\bOVER\s*\(\s*\)/gi, `OVER (PARTITION BY ${prefix})`)
}

/**
 * Rewrite `GROUPING("x")` to the constant 1 when x is not one of the query's
 * grouping columns.
 *
 * A measure can ask whether a dimension is rolled up on this row — "average
 * establishments per NAICS-6 code, but only above the NAICS-6 level" is written
 * `CASE WHEN GROUPING("ind_naics6") = 1 THEN ... END`. That is valid SQL only
 * while ind_naics6 is in the GROUP BY. Drop it from the pivot and the same
 * measure produced `Binder Error: GROUPING child "ind_naics6" must be a
 * grouping column` — the report failed outright rather than the measure
 * degrading.
 *
 * 1 is the right answer, not a way to dodge the error. GROUPING(x) = 1 means
 * "this row aggregates over every value of x", and a dimension absent from the
 * GROUP BY is aggregated over on every row. So the measure computes what it
 * says it computes, over the whole group.
 *
 * Only measure expressions from the schema go through here. `groupedDims` is
 * the grouping set of the specific SELECT the expression is about to be
 * embedded in, not of the query as a whole — a rollup query builds CTEs that
 * group by one axis, or by nothing at all, and an expression valid in the outer
 * ROLLUP is not valid in those.
 *
 * Three shapes are deliberately left alone, because for them "not a grouping
 * column" cannot be established and a wrong constant would be worse than the
 * error:
 *
 * - **A dimension whose SQL is an expression** (`YEAR("dt")` behind the name
 *   `yr`). `GROUPING("yr")` does not bind even when yr is on the pivot, since
 *   the GROUP BY holds the expression rather than the alias. Absent from the
 *   pivot it is still rewritten, which is right; present, it fails as before.
 * - **`GROUPING(a, b)`**, whose result is a bitmask rather than 0 or 1.
 * - **A qualified reference** such as `GROUPING("t"."c")`.
 *
 * One shape this cannot rescue at all: DuckDB rejects `GROUPING()` inside an
 * aggregate's argument (`GROUPING function is not supported here`), whichever
 * way the rewrite goes. Only a measure whose expression sits at the top level —
 * in practice `aggregation: 'custom'` — can use it. A measure that carries an
 * expression but is wrapped in `SUM(...)` still fails, as it does on master.
 */
export function neutralizeUngroupedGrouping(expression: string, groupedDims: Set<string>): string {
  if (!/GROUPING/i.test(expression)) return expression

  // Sticky, so it can be tried at one position at a time and string literals
  // stepped over — `'GROUPING("a")'` is data, not a call to rewrite.
  const call = /GROUPING\s*\(\s*(?:"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_]*))\s*\)/iy

  // Copy a quoted run verbatim. Both quote styles have to be consumed, not just
  // string literals: an apostrophe inside a quoted identifier — `"it's"` — would
  // otherwise open a phantom literal that swallows the rest of the expression.
  const copyQuoted = (start: number, quote: string): number => {
    let j = start + 1
    while (j < expression.length) {
      if (expression[j] !== quote) { j++; continue }
      if (expression[j + 1] === quote) { j += 2; continue }  // doubled = escaped
      j++
      break
    }
    return j
  }

  let out = ''
  let i = 0
  while (i < expression.length) {
    if (expression[i] === "'" || expression[i] === '"') {
      const j = copyQuoted(i, expression[i])
      out += expression.slice(i, j)
      i = j
      continue
    }

    // Only at an identifier boundary, so MY_GROUPING(...) and GROUPING_ID(...)
    // are not mistaken for the function. A preceding dot or closing quote means
    // a qualified name — `s.GROUPING(...)` is somebody else's function.
    const prev = i > 0 ? expression[i - 1] : ''
    if (!/[A-Za-z0-9_."]/.test(prev)) {
      call.lastIndex = i
      const m = call.exec(expression)
      if (m) {
        const name = m[1] !== undefined ? m[1].replace(/""/g, '"') : (m[2] as string)
        out += groupedDims.has(name) ? m[0] : '1'
        i = call.lastIndex
        continue
      }
    }

    out += expression[i]
    i++
  }
  return out
}

export function expandDimsVariable(expression: string, allDimensions: string[]): string {
  return expression.replace(/\$DIMS\(([^)]+)\)/g, (_match, inner: string) => {
    const excludeIds = new Set(inner.split(',').map(s => s.trim()))
    const remaining = allDimensions.filter(d => !excludeIds.has(d))
    if (remaining.length === 0) return '1'  // no partition needed
    return remaining.map(d => quoteIdent(d)).join(', ')
  })
}

export interface QuerySchema {
  dimensions: DimensionDefinition[]
  measures: MeasureDefinition[]
  hierarchies: HierarchyConfig[]
  timeDimensions?: TimeDimensionConfig[]
  flowDeclarations?: FlowDeclaration[]
  formats?: FormatConfig[]
}

export interface AggregationResult {
  sql: string
  displayFields: Map<string, string>  // dimension field -> displayField column name
}

export interface RollupResult {
  sql: string
  groupingColumns: string[]  // names of GROUPING() columns, e.g. ['_g_department', '_g_region']
  dimensionFields: string[]  // source fields of dimensions in order (rows then cols)
  rowDimensionCount: number  // first N dimensions are row dims; rest are column dims
  measureFields: string[]    // measure IDs (output column aliases)
  percentageFields?: string[] // percentage column aliases, e.g. ['revenue_pct']
  derivedMeasureFields?: string[] // comparison formula measure IDs (NULL at subtotal rows)
  displayColumns?: { field: string; column: string }[]  // dim field → __display column name
  sortColumns?: string[]     // dims whose _sort_<dim> column is present in the result
}

/** Options for result limiting (flat mode). */
interface LimitOpts {
  limitCols?: number    // add _top_cols CTE (ORDER BY + LIMIT)
  limitRows?: number    // add _top_rows CTE (ORDER BY + LIMIT)
}

/** Internal structured representation — keeps SQL in composable pieces. */
interface RollupParts {
  ctes: { name: string; body: string }[]
  mainQuery: string   // SELECT ... GROUP BY ... (no ORDER BY)
  orderBy: string     // 'ORDER BY ...' or ''
  groupingColumns: string[]
  dimensionFields: string[]
  rowDimensionCount: number
  measureFields: string[]
  percentageFields?: string[]
  derivedMeasureFields?: string[]  // comparison formula columns (NULL at subtotal rows)
  displayColumns?: { field: string; column: string }[]
  sortColumns?: string[]           // dims whose _sort_<dim> column this query outputs
}

function assembleSql(parts: RollupParts): string {
  const sections: string[] = []
  if (parts.ctes.length > 0) {
    const cteDefs = parts.ctes.map(c => `${c.name} AS (\n${c.body}\n)`)
    sections.push('WITH ' + cteDefs.join(',\n'))
  }
  sections.push(parts.mainQuery)
  if (parts.orderBy) sections.push(parts.orderBy)
  return sections.join('\n')
}

function toRollupResult(parts: RollupParts): RollupResult {
  return {
    sql: assembleSql(parts),
    groupingColumns: parts.groupingColumns,
    dimensionFields: parts.dimensionFields,
    rowDimensionCount: parts.rowDimensionCount,
    measureFields: parts.measureFields,
    ...(parts.percentageFields ? { percentageFields: parts.percentageFields } : {}),
    ...(parts.derivedMeasureFields?.length ? { derivedMeasureFields: parts.derivedMeasureFields } : {}),
    ...(parts.displayColumns?.length ? { displayColumns: parts.displayColumns } : {}),
    ...(parts.sortColumns?.length ? { sortColumns: parts.sortColumns } : {})
  }
}

const ALLOWED_AGGS = new Set(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'])

function safeAgg(agg: string): string {
  const upper = agg.toUpperCase()
  return ALLOWED_AGGS.has(upper) ? upper : 'SUM'
}

export class QueryBuilder {
  constructor(private schema: QuerySchema) {}

  /**
   * Columns carried by the summary view being queried, set for the duration of a
   * single build call.  Undefined when querying base data, or when the caller did
   * not say — in which case derived dimensions re-derive from their expression.
   */
  private viewDimensions: string[] | undefined

  /**
   * The grouping set for a SELECT that groups by nothing — a grand-total CTE,
   * or a ranking pass where every `GROUPING()` call is answered "rolled up".
   */
  private static readonly NO_GROUPING: Set<string> = new Set()

  /**
   * Resolve a dimension field name to its SQL expression (raw expression or quoted column).
   * When preAggregated is true (querying a summary view), use the raw column name —
   * the summary view has pre-computed derived expressions as named columns.
   */
  private resolveDimExpr(dim: string, preAggregated = false): string {
    if (preAggregated) {
      const def = this.schema.dimensions.find(d => d.sourceField === dim)
                || this.schema.dimensions.find(d => d.id === dim)
      const expr = def?.expression && isValidSqlExpression(def.expression) ? def.expression : null
      if (expr && def!.derivedFromField) {
        // A view built at this dimension's own grain carries it as a named column
        // and does NOT carry the column the expression reads, so the expression
        // would reference something that isn't there.  Read the column instead.
        const cols = this.viewDimensions
        if (cols && cols.includes(def!.id) && !cols.includes(def!.derivedFromField!)) {
          return quoteIdent(def!.id)
        }
        // Otherwise re-derive from the expression.  Summary views materialise
        // derived dims as named columns during creation, but if the dim was added
        // to the schema *after* the view was created the column won't exist;
        // the source column is present in that case, so the expression is safe.
        return expr
      }
      return quoteIdent(dim)
    }
    return resolveDimExprForSchema(this.schema, dim)
  }

  /**
   * Resolve a dimension's ORDER BY expression.
   * If the dimension has a sortExpression, returns MIN(sortExpression).
   * Otherwise returns the dimension's own expression (same as resolveDimExpr).
   * When useAlias is true (inside CTEs), references the pre-computed _sort_ column.
   */
  private resolveSortExpr(dim: string, preAggregated = false, useAlias = false): string {
    const def = this.schema.dimensions.find(d => d.sourceField === dim)
              || this.schema.dimensions.find(d => d.id === dim)
    if (def?.sortExpression && !preAggregated && isValidSqlExpression(def.sortExpression)) {
      if (useAlias) return `MIN(${quoteIdent('_sort_' + dim)})`
      // sortExpression is a SQL expression (e.g. QUARTER(CAST(...))), not a column name.
      // Use it as-is — the source column it references exists in the base table.
      return `MIN(${def.sortExpression})`
    }
    if (useAlias) return quoteIdent(dim)
    return this.resolveDimExpr(dim, preAggregated)
  }

  /**
   * Get sort column SELECT parts for dims that have sortExpression.
   * Returns expressions like: `MONTH("month") AS "_sort_month_name"`
   * For innermost CTEs that read from source data.
   */
  private getSortSelectParts(dims: string[], preAggregated = false): string[] {
    const parts: string[] = []
    // Summary views don't materialise sort expression results — the source columns
    // they reference may not exist.  Skip sort columns; resolveSortExpr will fall
    // through to the dim value itself for ORDER BY.
    if (preAggregated) return parts
    for (const dim of dims) {
      const def = this.schema.dimensions.find(d => d.sourceField === dim)
                || this.schema.dimensions.find(d => d.id === dim)
      if (def?.sortExpression && isValidSqlExpression(def.sortExpression)) {
        parts.push(`MIN(${def.sortExpression}) AS ${quoteIdent('_sort_' + dim)}`)
      }
    }
    return parts
  }

  /**
   * The dimensions among `dims` that carry a usable sortExpression, i.e. the ones
   * `getSortSelectParts` / `getSortPassthroughParts` emit a `_sort_<dim>` column for.
   * A query records these in `sortColumns` so later wrappers know which sort columns
   * they can reference instead of guessing from the schema.
   */
  private dimsWithSortColumn(dims: string[], preAggregated = false): string[] {
    if (preAggregated) return []
    return dims.filter(dim => {
      const def = this.schema.dimensions.find(d => d.sourceField === dim)
                || this.schema.dimensions.find(d => d.id === dim)
      return !!(def?.sortExpression && isValidSqlExpression(def.sortExpression))
    })
  }

  /**
   * Get sort column pass-through parts for intermediate CTEs.
   * Returns expressions like: `MIN("_sort_month_name") AS "_sort_month_name"`
   */
  private getSortPassthroughParts(dims: string[], preAggregated = false): string[] {
    // Must agree with getSortSelectParts about which dimensions produced a sort
    // column, or this passes through a column the inner query never emitted.
    // A summary view emits none, because the source columns a sortExpression
    // names may not exist in it.
    return this.dimsWithSortColumn(dims, preAggregated).map(dim => {
      const alias = quoteIdent('_sort_' + dim)
      return `MIN(${alias}) AS ${alias}`
    })
  }

  /**
   * Resolve a measure to its SQL expression.
   * When preAggregated is true (querying from a summary view), always use
   * the sourceField column — the expression's component columns don't exist.
   *
   * `groupedDims` is the grouping set of the SELECT this expression is going
   * into, so it must come from the caller: one rollup query emits CTEs that
   * group by the row axis, by the column axis, and by nothing.
   */
  private resolveMeasureExpr(m: MeasureDefinition, preAggregated: boolean, groupedDims: Set<string>): string {
    if (preAggregated) return quoteIdent(m.sourceField)
    if (m.aggregation === 'custom') {
      if (!m.expression || !isValidSqlExpression(m.expression)) {
        throw new Error(`Custom measure "${m.id}" requires a valid expression field`)
      }
      return neutralizeUngroupedGrouping(m.expression, groupedDims)
    }
    return (m.expression && isValidSqlExpression(m.expression))
      ? neutralizeUngroupedGrouping(m.expression, groupedDims)
      : quoteIdent(m.sourceField)
  }

  /**
   * Build a flat aggregation query (no ROLLUP, no totals).
   * Used for simple queries: distinct values, drill-down, leaf data for the outline table.
   */
  buildAggregation(opts: {
    dimensions: string[]    // physical field names
    values: PivotValue[]
    filters?: Filter[]
    includeDisplayFields?: boolean
    limit?: number
    source?: string         // table/view name (default: 'data')
    preAggregated?: boolean // true when source is a summary view (use sourceField, not expression)
    viewDimensions?: string[] // columns that summary view carries
  }): AggregationResult {
    const { dimensions, values, filters = [], includeDisplayFields = false } = opts
    const source = opts.source ?? 'data'
    const preAgg = opts.preAggregated ?? false
    this.viewDimensions = preAgg ? opts.viewDimensions : undefined
    const limit = opts.limit ?? DEFAULT_MAX_ROWS
    const groupedDims = new Set(dimensions)

    const displayFields = new Map<string, string>()
    const selectParts: string[] = []
    const groupByParts: string[] = []

    for (const dim of dimensions) {
      const dimDef = this.schema.dimensions.find(d => d.sourceField === dim)
                  || this.schema.dimensions.find(d => d.id === dim)
      const dimExpr = this.resolveDimExpr(dim, preAgg)
      const alias = quoteIdent(dim)

      if (dimExpr !== alias) {
        selectParts.push(`${dimExpr} AS ${alias}`)
      } else {
        selectParts.push(alias)
      }
      groupByParts.push(dimExpr)

      if (includeDisplayFields && dimDef?.descriptionField && dimDef.descriptionField !== dim) {
        const displayAlias = `${dim}__display`
        selectParts.push(`${quoteIdent(dimDef.descriptionField)} AS ${quoteIdent(displayAlias)}`)
        groupByParts.push(quoteIdent(dimDef.descriptionField))
        // It is in the GROUP BY, so GROUPING() on it binds and answers 0.
        groupedDims.add(dimDef.descriptionField)
        displayFields.set(dim, displayAlias)
      }
    }

    // Cast to DOUBLE to avoid HUGEINT issues (SUM on BIGINT returns HUGEINT which JS can't handle)
    for (const val of values) {
      const measure = this.schema.measures.find(m => m.id === val.field)
      const alias = measure?.id || val.field
      // Derived measures (comparison formulas) require other rows to compute — output NULL
      // in flat aggregation queries where no such context exists.
      if (measure?.derivedExpression) {
        selectParts.push(`CAST(NULL AS DOUBLE) AS ${quoteIdent(alias)}`)
        continue
      }
      const agg = measure?.aggregation || val.aggregation || 'sum'
      const fieldExpr = measure ? this.resolveMeasureExpr(measure, preAgg, groupedDims) : quoteIdent(val.field)
      if (agg === 'custom') {
        selectParts.push(`CAST((${fieldExpr}) AS DOUBLE) AS ${quoteIdent(alias)}`)
      } else {
        selectParts.push(`CAST(${safeAgg(agg)}(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(alias)}`)
      }
    }

    if (selectParts.length === 0) {
      selectParts.push('COUNT(*) AS row_count')
    }

    const whereClause = this.buildWhereClause(filters, preAgg)
    const groupByClause = groupByParts.length > 0
      ? `GROUP BY ${groupByParts.join(', ')}`
      : ''
    const orderByClause = dimensions.length > 0
      ? `ORDER BY ${dimensions.map(d => this.resolveSortExpr(d, preAgg)).join(', ')}`
      : ''
    const limitClause = limit > 0 ? `LIMIT ${limit}` : ''

    const parts = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${quoteIdent(source)}`,
      whereClause,
      groupByClause,
      orderByClause,
      limitClause
    ].filter(Boolean)

    return { sql: parts.join('\n'), displayFields }
  }

  /**
   * Build a cheap COUNT-only probe query to detect cardinality overflow.
   * Returns SQL that counts leaf-level group combinations up to probeLimit+1.
   * Path-agnostic — works for both single-pass and two-pass rollups.
   *
   * Result: single row with column `n`. If n > probeLimit, the caller knows
   * the full ROLLUP would exceed limits and should use flat mode instead.
   */
  buildProbeQuery(opts: {
    dimensions: string[]     // all dimensions (rows + cols) to GROUP BY
    filters?: Filter[]
    source?: string
    preAggregated?: boolean
    viewDimensions?: string[] // columns that summary view carries
    probeLimit: number
  }): string {
    const { dimensions, filters = [], probeLimit } = opts
    const source = opts.source ?? 'data'
    const preAgg = opts.preAggregated ?? false
    this.viewDimensions = preAgg ? opts.viewDimensions : undefined

    const dimExprs = dimensions.map(d => this.resolveDimExpr(d, preAgg))
    const groupBy = dimExprs.length > 0 ? `GROUP BY ${dimExprs.join(', ')}` : ''
    const whereClause = this.buildWhereClause(filters, preAgg)

    const inner = [
      `SELECT 1`,
      `FROM ${quoteIdent(source)}`,
      whereClause,
      groupBy,
      `LIMIT ${probeLimit + 1}`
    ].filter(Boolean).join('\n  ')

    return `SELECT COUNT(*) AS n FROM (\n  ${inner}\n) AS _check`
  }

  /**
   * Build a ROLLUP query: detail rows + subtotals + grand total in one result set.
   * GROUPING() columns indicate which level each row belongs to (0 = detail, 1 = rolled up).
   *
   * Single-pass when all measures are flow.
   * Multi-pass when any measure has timeAggregation !== 'flow' and there are time dimensions
   * not in the requested GROUP BY, or time-derived column dimensions that need special rollup.
   */
  buildRollupAggregation(opts: {
    rowDimensions: string[]      // row hierarchy dimensions (physical field names)
    columnDimensions?: string[]  // column dimensions (physical field names)
    measures: string[]           // measure IDs (from MeasureDefinition.id)
    filters?: Filter[]
    timeDimensions?: string[]    // override: time dim sourceFields not in requested dims
    source?: string              // table/view name (default: 'data')
    preAggregated?: boolean      // true when source is a summary view
    viewDimensions?: string[]    // columns that summary view carries
    displayMode?: 'pct_row' | 'pct_col' | 'pct_total'  // add percentage columns
    limitCols?: number           // if set, add _top_cols CTE with ORDER BY + LIMIT
    limitRows?: number           // if set, add _top_rows CTE with ORDER BY + LIMIT
    sort?: ReportSort            // explicit report sort (overrides default dimension order)
  }): RollupResult {
    const { rowDimensions, measures, filters = [] } = opts
    const source = opts.source ?? 'data'
    const preAgg = opts.preAggregated ?? false
    this.viewDimensions = preAgg ? opts.viewDimensions : undefined
    const columnDimensions = opts.columnDimensions ?? []
    const allDimensions = [...rowDimensions, ...columnDimensions]

    const measureDefs = measures.map(m => {
      const def = this.schema.measures.find(md => md.id === m)
      if (!def) throw new Error(`Unknown measure: ${m}`)
      return def
    })

    // Split: base measures run inside ROLLUP; derived measures (comparison formulas)
    // are computed post-ROLLUP via window functions and joined back in.
    const derivedMeasureDefs = measureDefs.filter(m => !!m.derivedExpression)
    const explicitBaseDefs = measureDefs.filter(m => !m.derivedExpression)

    // Auto-include any measures declared in dependsOn that weren't explicitly selected.
    // This ensures derived expressions can always reference their base columns in _base.
    const explicitBaseIds = new Set(explicitBaseDefs.map(m => m.id))
    const autoDeps: MeasureDefinition[] = []
    for (const derived of derivedMeasureDefs) {
      for (const depId of (derived.dependsOn ?? [])) {
        if (!explicitBaseIds.has(depId)) {
          const dep = this.schema.measures.find(m => m.id === depId)
          if (!dep) throw new Error(`Measure "${derived.id}" depends on unknown measure "${depId}"`)
          if (!dep.derivedExpression) {
            autoDeps.push(dep)
            explicitBaseIds.add(depId)
          }
        }
      }
    }

    const baseMeasureDefs = [...explicitBaseDefs, ...autoDeps]

    const isLongForm = this.isLongFormMode()
    const hasStockMeasures = baseMeasureDefs.some(m => m.timeAggregation && m.timeAggregation !== 'flow')
    const timeDims = opts.timeDimensions ?? this.findTimeDimensionsNotInGroup(allDimensions)
    const hasTimeColDims = (hasStockMeasures || isLongForm) && columnDimensions.some(d => this.isTimeDerivedDim(d))
    const hasTimeRowDims = isLongForm && rowDimensions.some(d => this.isTimeDerivedDim(d))

    const limitOpts = { limitCols: opts.limitCols, limitRows: opts.limitRows }

    let parts: RollupParts
    if (isLongForm && (timeDims.length > 0 || hasTimeColDims || hasTimeRowDims)) {
      // Long-form always uses two-pass when time dims are involved (any axis or hidden).
      // This avoids the flat mode decomposition problem where stock/flow identity
      // depends on a qualifier dimension value that ROLLUP may collapse.
      parts = this.buildTwoPassRollup(rowDimensions, columnDimensions, baseMeasureDefs, filters, timeDims, source, preAgg, limitOpts)
    } else if (hasStockMeasures && (timeDims.length > 0 || hasTimeColDims)) {
      parts = this.buildTwoPassRollup(rowDimensions, columnDimensions, baseMeasureDefs, filters, timeDims, source, preAgg, limitOpts)
    } else {
      parts = this.buildSinglePassRollup(rowDimensions, columnDimensions, baseMeasureDefs, filters, source, preAgg, limitOpts)
    }

    // Attach derived measures before percentages so pct wrapper can skip them
    if (derivedMeasureDefs.length > 0) {
      parts = this.wrapWithDerivedMeasures(parts, derivedMeasureDefs)
    }

    if (opts.displayMode) {
      parts = this.wrapWithPercentages(parts, opts.displayMode, rowDimensions, columnDimensions)
    }

    // Add true totals (unfiltered by top-N) when flat mode limiting is active
    if (limitOpts.limitCols || limitOpts.limitRows) {
      parts = this.addTrueTotals(parts, baseMeasureDefs, filters, source, preAgg, limitOpts, rowDimensions, columnDimensions)
    }

    // Add display lookup JOINs for dimensions with descriptionField
    parts = this.addDisplayLookups(parts, allDimensions, source, preAgg)

    // The report sort is applied last, so its ORDER BY is the outermost one and
    // nothing downstream can reshuffle what it produced.
    if (opts.sort) parts = this.applyReportSort(parts, opts.sort)

    return toRollupResult(parts)
  }

  /**
   * Reorder a finished rollup by an explicit report sort.
   *
   * The query is wrapped one level (`_presort`) so every key can be written
   * against plain output columns. That keeps one implementation for all the
   * shapes a rollup can end up in — single-pass, two-pass, percentage wrapper,
   * derived-measure join, top-N with true totals — and puts the sort outside
   * every one of them, so nothing downstream reshuffles the result.
   *
   * The grouping flag `_g_<dim>` stays the first key at every level, ahead of
   * whatever the user sorted on. That is what keeps subtotals in place: a
   * subtotal row has `_g_ = 1` for the levels below it, so it always sorts after
   * the detail rows it summarises, and the grand total after everything.
   *
   * Sorting by a measure ranks each level by the member's *own group total*
   * rather than by the cell value on the row, which is why a member's detail
   * rows, its subtotal row and each of its column cells all carry the same key
   * and travel together.
   *
   * A sort naming a measure that is not in the query, or a dimension that is not
   * on either axis, is dropped rather than raising — a bookmark saved before the
   * field was removed still opens.
   */
  private applyReportSort(base: RollupParts, sort: ReportSort): RollupParts {
    const allDims = base.dimensionFields
    if (allDims.length === 0) return base

    const rowDims = allDims.slice(0, base.rowDimensionCount)
    const colDims = allDims.slice(base.rowDimensionCount)

    const axis: 'rows' | 'columns' | null = sort.by === 'dimension'
      ? (rowDims.includes(sort.field) ? 'rows' : colDims.includes(sort.field) ? 'columns' : null)
      : (sort.axis ?? 'rows')
    if (!axis) return base

    const axisDims = axis === 'rows' ? rowDims : colDims
    const otherDims = axis === 'rows' ? colDims : rowDims
    if (axisDims.length === 0) return base

    const dir = sort.direction === 'desc' ? 'DESC' : 'ASC'
    const sortCols = new Set(base.sortColumns ?? [])
    // The dimension's own ordering: its sortExpression column when the query
    // produced one, else the dimension value.
    const dimKey = (dim: string) => sortCols.has(dim) ? quoteIdent('_sort_' + dim) : quoteIdent(dim)

    let keysFor: (dim: string, axisIndex: number) => string[] | null
    if (sort.by === 'measure') {
      if (!base.measureFields.includes(sort.measure)) return base
      const ref = quoteIdent(sort.measure)
      // Ranking by one column means reading the value at that column rather than
      // the member's whole-row total: the named opposite-axis dimensions are
      // pinned to those values instead of being rolled up. A path naming more
      // levels than that axis has, or values no longer present, simply matches
      // nothing and the sort falls back to the tie-break key.
      const scope = (sort.colPath ?? []).slice(0, otherDims.length)
      const otherConds = otherDims.map((d, k) =>
        k < scope.length
          ? `${quoteIdent('_g_' + d)} = 0 AND ${quoteIdent(d)} = '${this.escapeString(scope[k])}'`
          : `${quoteIdent('_g_' + d)} = 1`
      )
      keysFor = (dim, i) => {
        // The member's group total: everything below this level on its own axis
        // rolled up, and the other axis rolled up entirely — or pinned to the
        // scoped column when the sort names one.
        const conds = [
          ...axisDims.slice(i + 1).map(d => `${quoteIdent('_g_' + d)} = 1`),
          ...otherConds
        ]
        const cond = conds.length > 0 ? conds.join(' AND ') : '1=1'
        const partition = axisDims.slice(0, i + 1)
          .flatMap(d => [quoteIdent('_g_' + d), quoteIdent(d)])
          .join(', ')
        return [
          `MAX(CASE WHEN ${cond} THEN ${ref} END) OVER (PARTITION BY ${partition}) ${dir} NULLS LAST`,
          dimKey(dim)   // tie-break, so equal totals still come out in a fixed order
        ]
      }
    } else {
      const field = sort.field
      keysFor = dim => dim === field ? [`${dimKey(dim)} ${dir}`] : null
    }

    const orderParts: string[] = []
    for (const dim of allDims) {
      orderParts.push(quoteIdent(`_g_${dim}`))
      const axisIndex = axisDims.indexOf(dim)
      const keys = axisIndex >= 0 ? keysFor(dim, axisIndex) : null
      orderParts.push(...(keys ?? [dimKey(dim)]))
    }

    return {
      ...base,
      ctes: [...base.ctes, { name: '_presort', body: base.mainQuery }],
      mainQuery: 'SELECT * FROM _presort',
      orderBy: `ORDER BY ${orderParts.join(', ')}`
    }
  }

  private buildSinglePassRollup(
    rowDimensions: string[],
    columnDimensions: string[],
    measures: MeasureDefinition[],
    filters: Filter[],
    source: string,
    preAggregated = false,
    limitOpts: LimitOpts = {}
  ): RollupParts {
    // Stock measures with time-derived row dims need CTE-based decomposition
    // so the ROLLUP total uses time aggregation (weighted_avg/eop) instead of SUM.
    // Long-form mode also needs this when qualifier values have mixed stock/flow behavior.
    const hasTimeRowStock = (
      measures.some(m => m.timeAggregation && m.timeAggregation !== 'flow') ||
      this.isLongFormMode()
    ) && rowDimensions.some(d => this.isTimeDerivedDim(d))

    // If flat mode limiting or time-row stock decomposition is needed, delegate to CTE builder
    if (hasTimeRowStock || limitOpts.limitCols || limitOpts.limitRows) {
      return this.buildFlatModeSinglePass(
        rowDimensions, columnDimensions, measures, filters, source, preAggregated, limitOpts
      )
    }

    // Deduplicate: a dim on both axes should appear once in SELECT/GROUPING/ORDER BY.
    // It stays in rowDimensions for the ROLLUP; column-only dims get GROUPING SETS.
    const allDimensions = [...rowDimensions, ...columnDimensions.filter(d => !rowDimensions.includes(d))]
    const groupingColumns: string[] = []
    const selectParts: string[] = []
    const measureFields: string[] = []

    for (const dim of allDimensions) {
      const dimExpr = this.resolveDimExpr(dim, preAggregated)
      // Prefix assumption: source data columns won't start with '_g_'
      const gCol = `_g_${dim}`
      groupingColumns.push(gCol)
      selectParts.push(`GROUPING(${dimExpr}) AS ${quoteIdent(gCol)}`)
    }

    for (const dim of allDimensions) {
      const dimExpr = this.resolveDimExpr(dim, preAggregated)
      if (dimExpr !== quoteIdent(dim)) {
        selectParts.push(`${dimExpr} AS ${quoteIdent(dim)}`)
      } else {
        selectParts.push(dimExpr)
      }
    }

    // Expose _sort_<dim> for any dimension with a sortExpression. The percentage
    // wrapper below selects from this query as a CTE and orders by that alias, so
    // without it a sortExpression plus any percent display mode builds SQL that
    // references a column nothing produced.
    selectParts.push(...this.getSortSelectParts(allDimensions, preAggregated))

    for (const m of measures) {
      const fieldExpr = this.resolveMeasureExpr(m, preAggregated, new Set(allDimensions))
      if (m.aggregation === 'custom') {
        selectParts.push(`CAST((${fieldExpr}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      } else {
        const agg = safeAgg(m.aggregation || 'sum')
        selectParts.push(`CAST(${agg}(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      }
      measureFields.push(m.id)
    }

    const whereClause = this.buildWhereClause(filters, preAggregated)
    const groupByClause = this.buildRollupGroupBy(rowDimensions, columnDimensions, false, preAggregated)

    const orderParts: string[] = []
    for (const dim of allDimensions) {
      const dimExpr = this.resolveDimExpr(dim, preAggregated)
      orderParts.push(`GROUPING(${dimExpr})`)
      orderParts.push(this.resolveSortExpr(dim, preAggregated))
    }
    const orderByClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

    const mainQuery = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM ${quoteIdent(source)}`,
      whereClause,
      groupByClause,
    ].filter(Boolean).join('\n')

    return {
      ctes: [],
      mainQuery,
      orderBy: orderByClause,
      groupingColumns,
      dimensionFields: allDimensions,
      rowDimensionCount: rowDimensions.length,
      measureFields,
      sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated)
    }
  }

  /**
   * Build a single-pass ROLLUP with flat mode limiting.
   *
   * Creates _top_rows and/or _top_cols CTEs that find the top-N dimension
   * values by first metric DESC. A _filtered CTE restricts the source data
   * to those values. The outer ROLLUP runs against _filtered.
   *
   * AVG measures are decomposed to SUM+COUNT in _filtered and reconstructed
   * in the outer ROLLUP, so subtotals are correct.
   */
  private buildFlatModeSinglePass(
    rowDimensions: string[],
    columnDimensions: string[],
    measures: MeasureDefinition[],
    filters: Filter[],
    source: string,
    preAggregated: boolean,
    limitOpts: LimitOpts
  ): RollupParts {
    const allDimensions = [...rowDimensions, ...columnDimensions.filter(d => !rowDimensions.includes(d))]
    const groupingColumns: string[] = []
    const measureFields: string[] = []
    const ctes: { name: string; body: string }[] = []
    const whereClause = this.buildWhereClause(filters, preAggregated)

    // Resolve dimension expressions for the source table
    const dimExprs = allDimensions.map(d => {
      const expr = this.resolveDimExpr(d, preAggregated)
      return { dim: d, expr, alias: quoteIdent(d) }
    })

    // First metric expression — used for ORDER BY in top-N CTEs
    // If no measures, skip top-N CTEs (nothing to rank by)
    const firstMeasure = measures.length > 0 ? measures[0] : null
    // Resolved per axis: _top_rows groups by the row dimensions and _top_cols by
    // the column ones, so they are two different grouping sets. Ranking by a
    // measure whose GROUPING() call was answered for the wrong set picks the
    // wrong members rather than failing — it collapses the ORDER BY to a
    // constant and keeps whichever rows the engine happened to emit first.
    const firstMetricOrderExprFor = (dims: string[]): string | null => {
      if (!firstMeasure) return null
      const expr = this.resolveMeasureExpr(firstMeasure, preAggregated, new Set(dims))
      // For custom measures the expression already contains aggregation — don't wrap it again.
      return firstMeasure.aggregation === 'custom'
        ? expr
        : `${safeAgg(firstMeasure.aggregation || 'sum')}(${expr})`
    }

    // ── _top_rows CTE: top-N row dimension combos by first metric ──
    if (limitOpts.limitRows && rowDimensions.length > 0 && firstMeasure) {
      const firstMetricOrderExpr = firstMetricOrderExprFor(rowDimensions)
      const rowExprs = rowDimensions.map(d => {
        const expr = this.resolveDimExpr(d, preAggregated)
        return { dim: d, expr, alias: quoteIdent(d) }
      })
      const selectParts = rowExprs.map(r => r.expr !== r.alias ? `${r.expr} AS ${r.alias}` : r.alias)
      const groupBy = rowExprs.map(r => r.expr).join(', ')
      const cte = [
        `SELECT ${selectParts.join(', ')}`,
        `FROM ${quoteIdent(source)}`,
        whereClause,
        `GROUP BY ${groupBy}`,
        `ORDER BY ${firstMetricOrderExpr} DESC`,
        `LIMIT ${limitOpts.limitRows}`
      ].filter(Boolean).join('\n  ')
      ctes.push({ name: '_top_rows', body: `  ${cte}` })
    }

    // ── _top_cols CTE: top-N column dimension combos by first metric ──
    if (limitOpts.limitCols && columnDimensions.length > 0 && firstMeasure) {
      const firstMetricOrderExpr = firstMetricOrderExprFor(columnDimensions)
      const colExprs = columnDimensions.map(d => {
        const expr = this.resolveDimExpr(d, preAggregated)
        return { dim: d, expr, alias: quoteIdent(d) }
      })
      const selectParts = colExprs.map(c => c.expr !== c.alias ? `${c.expr} AS ${c.alias}` : c.alias)
      const groupBy = colExprs.map(c => c.expr).join(', ')
      const cte = [
        `SELECT ${selectParts.join(', ')}`,
        `FROM ${quoteIdent(source)}`,
        whereClause,
        `GROUP BY ${groupBy}`,
        `ORDER BY ${firstMetricOrderExpr} DESC`,
        `LIMIT ${limitOpts.limitCols}`
      ].filter(Boolean).join('\n  ')
      ctes.push({ name: '_top_cols', body: `  ${cte}` })
    }

    // ── _filtered CTE: source data restricted to top-N rows/cols ──
    // Only add IN filters when the corresponding _top_* CTE was created
    const filterConditions: string[] = []
    if (limitOpts.limitRows && rowDimensions.length > 0 && firstMeasure) {
      const rowCols = rowDimensions.map(d => this.resolveDimExpr(d, preAggregated)).join(', ')
      const rowAliases = rowDimensions.map(d => quoteIdent(d)).join(', ')
      filterConditions.push(`(${rowCols}) IN (SELECT ${rowAliases} FROM _top_rows)`)
    }
    if (limitOpts.limitCols && columnDimensions.length > 0 && firstMeasure) {
      const colCols = columnDimensions.map(d => this.resolveDimExpr(d, preAggregated)).join(', ')
      const colAliases = columnDimensions.map(d => quoteIdent(d)).join(', ')
      filterConditions.push(`(${colCols}) IN (SELECT ${colAliases} FROM _top_cols)`)
    }

    // Combine user filters with top-N filters into a single WHERE clause
    const userConditions = this.buildWhereConditions(filters, preAggregated)
    const allConditions = [...userConditions, ...filterConditions]
    const allFilters = allConditions.length > 0 ? `WHERE ${allConditions.join('\n  AND ')}` : ''

    const customMeasures = measures.filter(m => m.aggregation === 'custom')
    const nonCustomMeasures = measures.filter(m => m.aggregation !== 'custom')
    const hasMixed = customMeasures.length > 0 && nonCustomMeasures.length > 0

    // ── Custom-only: ROLLUP directly on source ────────────────────────────
    // Custom expressions already contain their own aggregation. Querying the
    // source directly avoids the double-aggregate error that would occur if we
    // pre-aggregated in a _filtered CTE and then re-aggregated in the outer ROLLUP.
    if (nonCustomMeasures.length === 0) {
      const outerSelectParts: string[] = []
      for (const dim of allDimensions) {
        const gCol = `_g_${dim}`
        groupingColumns.push(gCol)
        outerSelectParts.push(`GROUPING(${this.resolveDimExpr(dim, preAggregated)}) AS ${quoteIdent(gCol)}`)
      }
      for (const { expr, alias } of dimExprs) {
        outerSelectParts.push(expr !== alias ? `${expr} AS ${alias}` : alias)
      }
      for (const m of customMeasures) {
        measureFields.push(m.id)
        outerSelectParts.push(`CAST((${this.resolveMeasureExpr(m, preAggregated, new Set(allDimensions))}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      }
      outerSelectParts.push(...this.getSortSelectParts(allDimensions, preAggregated))

      const groupByClause = this.buildRollupGroupBy(rowDimensions, columnDimensions, false, preAggregated)
      const orderParts: string[] = []
      for (const dim of allDimensions) {
        orderParts.push(`GROUPING(${this.resolveDimExpr(dim, preAggregated)})`)
        orderParts.push(this.resolveSortExpr(dim, preAggregated))
      }
      const orderByClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

      const mainQuery = [
        `SELECT ${outerSelectParts.join(', ')}`,
        `FROM ${quoteIdent(source)}`,
        allFilters,
        groupByClause,
      ].filter(Boolean).join('\n')

      return { ctes, mainQuery, orderBy: orderByClause, groupingColumns, dimensionFields: allDimensions, rowDimensionCount: rowDimensions.length, measureFields, sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated) }
    }

    // ── Non-custom (or mixed): build _filtered CTE ────────────────────────
    // When mixed, only non-custom measures flow through _filtered + outer ROLLUP.
    // Custom measures get their own _custom CTE (direct ROLLUP on source) and are
    // joined onto the non-custom results at the end — no _preagg needed.
    const filteredMeasures = hasMixed ? nonCustomMeasures : measures

    // Build _filtered as leaf-level aggregation (like probe but ordered/filtered)
    const filteredSelectParts: string[] = []
    for (const { expr, alias } of dimExprs) {
      filteredSelectParts.push(expr !== alias ? `${expr} AS ${alias}` : alias)
    }

    // Detect time-derived row dims with stock measures — need decomposition for correct ROLLUP totals
    const hasTimeRowStock = filteredMeasures.some(m => m.timeAggregation && m.timeAggregation !== 'flow') &&
      rowDimensions.some(d => this.isTimeDerivedDim(d))

    const avgDecomp = new Map<string, { sumAlias: string; countAlias: string }>()
    const stockRowDecomp = new Map<string,
      { type: 'weighted_avg'; numAlias: string; denAlias: string } |
      { type: 'eop'; timeAlias: string | null }>()
    for (const m of filteredMeasures) {
      const agg = safeAgg(m.aggregation || 'sum')
      const fieldExpr = this.resolveMeasureExpr(m, preAggregated, new Set(allDimensions))
      measureFields.push(m.id)

      if (agg === 'AVG') {
        const sumAlias = `${m.id}__sum`
        const countAlias = `${m.id}__count`
        avgDecomp.set(m.id, { sumAlias, countAlias })
        filteredSelectParts.push(`CAST(SUM(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(sumAlias)}`)
        filteredSelectParts.push(`CAST(COUNT(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(countAlias)}`)
      } else if (hasTimeRowStock && m.timeAggregation && m.timeAggregation !== 'flow') {
        // Stock measure with time dim on rows: decompose for correct ROLLUP totals.
        // The _filtered CTE groups by all dims (including the time dim), so each row
        // has a specific time period. We output the entity-aggregated value plus weight
        // components so the outer ROLLUP can compute weighted_avg/eop correctly.
        const aggExpr = `CAST(${agg}(${fieldExpr}) AS DOUBLE)`
        const ta = m.timeAggregation
        if (ta === 'weighted_avg') {
          const numAlias = `${m.id}__wn`
          const denAlias = `${m.id}__wd`
          stockRowDecomp.set(m.id, { type: 'weighted_avg', numAlias, denAlias })
          // Weight uses the time grouping column (available after GROUP BY)
          const weightExpr = this.buildWeightExpression(true)
          filteredSelectParts.push(`${aggExpr} * ${weightExpr} AS ${quoteIdent(numAlias)}`)
          filteredSelectParts.push(`CAST(${weightExpr} AS DOUBLE) AS ${quoteIdent(denAlias)}`)
        } else if (ta === 'eop') {
          const timeSourceCol = this.getTimeSourceColumn()
          filteredSelectParts.push(`${aggExpr} AS ${quoteIdent(m.id)}`)
          if (timeSourceCol) {
            const timeAlias = `${m.id}__et`
            stockRowDecomp.set(m.id, { type: 'eop', timeAlias })
            // Copy the time column value for ARG_MAX in outer ROLLUP
            filteredSelectParts.push(`${quoteIdent(timeSourceCol)} AS ${quoteIdent(timeAlias)}`)
          } else {
            stockRowDecomp.set(m.id, { type: 'eop', timeAlias: null })
          }
        } else {
          filteredSelectParts.push(`${aggExpr} AS ${quoteIdent(m.id)}`)
        }
      } else {
        filteredSelectParts.push(`CAST(${agg}(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      }
    }
    // Custom measure IDs come from _custom in the mixed path — register them now so
    // measureFields is complete before returning.
    for (const m of customMeasures) {
      measureFields.push(m.id)
    }

    // Add sort columns for dims with sortExpression
    filteredSelectParts.push(...this.getSortSelectParts(allDimensions, preAggregated))

    const filteredGroupBy = dimExprs.map(d => d.expr).join(', ')
    const filteredCte = [
      `SELECT ${filteredSelectParts.join(', ')}`,
      `FROM ${quoteIdent(source)}`,
      allFilters,
      `GROUP BY ${filteredGroupBy}`,
    ].filter(Boolean).join('\n  ')
    ctes.push({ name: '_filtered', body: `  ${filteredCte}` })

    // ── Outer ROLLUP reading from _filtered ──
    const outerSelectParts: string[] = []

    for (const dim of allDimensions) {
      const gCol = `_g_${dim}`
      groupingColumns.push(gCol)
      outerSelectParts.push(`GROUPING(${quoteIdent(dim)}) AS ${quoteIdent(gCol)}`)
    }
    for (const dim of allDimensions) {
      outerSelectParts.push(quoteIdent(dim))
    }

    for (const m of filteredMeasures) {
      const agg = safeAgg(m.aggregation || 'sum')
      const avgDec = avgDecomp.get(m.id)
      const stockDec = stockRowDecomp.get(m.id)
      if (avgDec) {
        outerSelectParts.push(
          `SUM(${quoteIdent(avgDec.sumAlias)}) / NULLIF(SUM(${quoteIdent(avgDec.countAlias)}), 0) AS ${quoteIdent(m.id)}`
        )
      } else if (stockDec?.type === 'weighted_avg') {
        outerSelectParts.push(
          `SUM(${quoteIdent(stockDec.numAlias)}) / NULLIF(SUM(${quoteIdent(stockDec.denAlias)}), 0) AS ${quoteIdent(m.id)}`
        )
      } else if (stockDec?.type === 'eop') {
        if (stockDec.timeAlias) {
          outerSelectParts.push(
            `ARG_MAX(${quoteIdent(m.id)}, ${quoteIdent(stockDec.timeAlias)}) AS ${quoteIdent(m.id)}`
          )
        } else {
          outerSelectParts.push(`MAX(${quoteIdent(m.id)}) AS ${quoteIdent(m.id)}`)
        }
      } else {
        const outerAgg = (agg === 'MIN' || agg === 'MAX') ? agg : 'SUM'
        outerSelectParts.push(`CAST(${outerAgg}(${quoteIdent(m.id)}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      }
    }

    const groupByClause = this.buildRollupGroupBy(rowDimensions, columnDimensions, true)

    if (!hasMixed) {
      // ── Pure non-custom: the ROLLUP is the final query ─────────────────
      // Sort columns are carried out of the ROLLUP as well as used in its ORDER BY,
      // so a wrapper above it (percentages, an explicit report sort) can order by
      // the same key by name.
      outerSelectParts.push(...this.getSortPassthroughParts(allDimensions, preAggregated))
      const orderParts: string[] = []
      for (const dim of allDimensions) {
        orderParts.push(`GROUPING(${quoteIdent(dim)})`)
        orderParts.push(this.resolveSortExpr(dim, preAggregated, true))
      }
      const orderByClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

      const mainQuery = [
        `SELECT ${outerSelectParts.join(', ')}`,
        `FROM _filtered`,
        groupByClause,
      ].filter(Boolean).join('\n')

      return { ctes, mainQuery, orderBy: orderByClause, groupingColumns, dimensionFields: allDimensions, rowDimensionCount: rowDimensions.length, measureFields, sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated) }
    }

    // ── Mixed: wrap non-custom ROLLUP as _flow CTE, join with _custom ─────
    // Sort columns must be in _flow's SELECT so the final query can ORDER BY them
    // by column name (the outer SELECT is not a GROUP BY context).
    outerSelectParts.push(...this.getSortPassthroughParts(allDimensions, preAggregated))

    const flowCteBody = [
      `SELECT ${outerSelectParts.join(', ')}`,
      `FROM _filtered`,
      groupByClause,
    ].filter(Boolean).join('\n  ')
    ctes.push({ name: '_flow', body: `  ${flowCteBody}` })

    // _custom CTE: ROLLUP custom measures directly on source.
    // No _filtered needed — custom expressions contain their own aggregation and
    // run correctly against raw source rows. The same top-N filters (from allFilters)
    // that restrict _filtered also restrict _custom, keeping both in sync.
    // No GROUPING() columns here — they would duplicate _flow's _g_* names and cause
    // ambiguous column errors when addTrueTotals wraps the JOIN as a subquery.
    const customSelectParts: string[] = []
    for (const { expr, alias } of dimExprs) {
      customSelectParts.push(expr !== alias ? `${expr} AS ${alias}` : alias)
    }
    for (const m of customMeasures) {
      customSelectParts.push(`CAST((${this.resolveMeasureExpr(m, preAggregated, new Set(allDimensions))}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
    }

    const customGroupBy = this.buildRollupGroupBy(rowDimensions, columnDimensions, false, preAggregated)
    const customCteBody = [
      `SELECT ${customSelectParts.join(', ')}`,
      `FROM ${quoteIdent(source)}`,
      allFilters,
      customGroupBy,
    ].filter(Boolean).join('\n  ')
    ctes.push({ name: '_custom', body: `  ${customCteBody}` })

    // JOIN condition: match on dimension values using null-safe equality.
    // Both _flow and _custom use the same ROLLUP structure, so rolled-up NULL values
    // align naturally. IS NOT DISTINCT FROM treats NULL=NULL as true, which correctly
    // matches the grand-total rows from both CTEs.
    const joinConds = allDimensions.map(dim =>
      `_flow.${quoteIdent(dim)} IS NOT DISTINCT FROM _custom.${quoteIdent(dim)}`
    )
    const joinClause = joinConds.length > 0
      ? `JOIN _custom\n  ON ${joinConds.join('\n  AND ')}`
      : `CROSS JOIN _custom`

    // ORDER BY references pre-computed columns from _flow (column names, not aggregates).
    const orderParts: string[] = []
    for (const dim of allDimensions) {
      orderParts.push(quoteIdent(`_g_${dim}`))
      const def = this.schema.dimensions.find(d => d.sourceField === dim || d.id === dim)
      if (def?.sortExpression && isValidSqlExpression(def.sortExpression) && !preAggregated) {
        orderParts.push(quoteIdent(`_sort_${dim}`))
      } else {
        orderParts.push(quoteIdent(dim))
      }
    }
    const orderByClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

    // Build explicit column list from _flow (by name, not _flow.*) to avoid DuckDB's
    // ambiguity error — DuckDB flags unqualified column references in ORDER BY as
    // ambiguous when the FROM clause is a JOIN and both sides share column names.
    // Pushing the JOIN into a _join CTE makes the final SELECT read from a single
    // source, so ORDER BY column names are unambiguous.
    const flowCols = [
      ...groupingColumns.map(gc => `_flow.${quoteIdent(gc)}`),
      ...allDimensions.map(dim => `_flow.${quoteIdent(dim)}`),
      ...filteredMeasures.map(m => `_flow.${quoteIdent(m.id)}`),
      ...allDimensions.flatMap(dim => {
        const def = this.schema.dimensions.find(d => d.sourceField === dim || d.id === dim)
        return (def?.sortExpression && isValidSqlExpression(def.sortExpression) && !preAggregated)
          ? [`_flow.${quoteIdent('_sort_' + dim)}`]
          : []
      }),
    ]
    const allSelectCols = [...flowCols, ...customMeasures.map(m => `_custom.${quoteIdent(m.id)}`)]
    const joinCteBody = [
      `SELECT ${allSelectCols.join(', ')}`,
      `FROM _flow`,
      joinClause,
    ].join('\n  ')
    ctes.push({ name: '_join', body: `  ${joinCteBody}` })
    const mainQuery = `SELECT *\nFROM _join`

    return { ctes, mainQuery, orderBy: orderByClause, groupingColumns, dimensionFields: allDimensions, rowDimensionCount: rowDimensions.length, measureFields, sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated) }
  }

  private buildTwoPassRollup(
    rowDimensions: string[],
    columnDimensions: string[],
    measures: MeasureDefinition[],
    filters: Filter[],
    timeDims: string[],
    source: string,
    preAggregated = false,
    limitOpts: LimitOpts = {}
  ): RollupParts {
    const allDimensions = [...rowDimensions, ...columnDimensions.filter(d => !rowDimensions.includes(d))]
    const groupingColumns: string[] = []
    const measureFields: string[] = []

    // In long-form mode, qualifier dimensions must be in GROUP BY through the middle CTE
    // so the CASE WHEN has a single qualifier value per group. Track them separately —
    // they go in inner/middle GROUP BY but NOT in allDimensions or the outer ROLLUP.
    // (If the qualifier IS on rows/columns, it's already in allDimensions and not listed here.)
    const hiddenQualifierDims: string[] = []
    if (this.isLongFormMode()) {
      const allDimSet = new Set(allDimensions)
      for (const fd of this.schema.flowDeclarations!) {
        const qualDim = this.schema.dimensions.find(d => d.id === fd.dimensionId)
        const qualField = qualDim?.sourceField ?? fd.dimensionId
        if (!allDimSet.has(qualField)) {
          hiddenQualifierDims.push(qualField)
          allDimSet.add(qualField)
        }
      }
    }

    // Identify time-derived column dimensions: their rollup needs weighted_avg, not SUM.
    const timeColDimSet = new Set(columnDimensions.filter(d => this.isTimeDerivedDim(d)))
    const hasTimeColDims = timeColDimSet.size > 0

    // ============ FLAT MODE CTEs ============
    // When limitRows/limitCols are set, build _top_rows/_top_cols CTEs against the
    // source table. These find top-N dimension values by first metric (SUM approximation).
    // The inner query gets WHERE IN filters to restrict to those values.
    // Time source columns are NOT limited — only requested dimensions.
    const flatCtes: { name: string; body: string }[] = []
    const flatFilters: string[] = []

    if ((limitOpts.limitRows || limitOpts.limitCols) && measures.length > 0) {
      const firstMeasure = measures[0]
      // Per axis, for the same reason as in buildRollupParts.
      const firstMetricExprFor = (dims: string[]) =>
        this.resolveMeasureExpr(firstMeasure, preAggregated, new Set(dims))
      // Use SUM as a proxy for ranking — it's an approximation for stock measures
      // (SUM of monthly snapshots isn't the "correct" stock value, but it's a
      // reasonable proxy for picking the largest entities).

      if (limitOpts.limitRows && rowDimensions.length > 0) {
        const rowExprs = rowDimensions.map(d => {
          const expr = this.resolveDimExpr(d, preAggregated)
          return { dim: d, expr, alias: quoteIdent(d) }
        })
        const selectParts = rowExprs.map(r => r.expr !== r.alias ? `${r.expr} AS ${r.alias}` : r.alias)
        const groupBy = rowExprs.map(r => r.expr).join(', ')
        const whereClause = this.buildWhereClause(filters, preAggregated)
        const cte = [
          `SELECT ${selectParts.join(', ')}`,
          `FROM ${quoteIdent(source)}`,
          whereClause,
          `GROUP BY ${groupBy}`,
          `ORDER BY SUM(${firstMetricExprFor(rowDimensions)}) DESC`,
          `LIMIT ${limitOpts.limitRows}`
        ].filter(Boolean).join('\n  ')
        flatCtes.push({ name: '_top_rows', body: `  ${cte}` })

        const rowCols = rowDimensions.map(d => this.resolveDimExpr(d, preAggregated)).join(', ')
        const rowAliases = rowDimensions.map(d => quoteIdent(d)).join(', ')
        flatFilters.push(`(${rowCols}) IN (SELECT ${rowAliases} FROM _top_rows)`)
      }

      if (limitOpts.limitCols && columnDimensions.length > 0) {
        const colExprs = columnDimensions.map(d => {
          const expr = this.resolveDimExpr(d, preAggregated)
          return { dim: d, expr, alias: quoteIdent(d) }
        })
        const selectParts = colExprs.map(c => c.expr !== c.alias ? `${c.expr} AS ${c.alias}` : c.alias)
        const groupBy = colExprs.map(c => c.expr).join(', ')
        const whereClause = this.buildWhereClause(filters, preAggregated)
        const cte = [
          `SELECT ${selectParts.join(', ')}`,
          `FROM ${quoteIdent(source)}`,
          whereClause,
          `GROUP BY ${groupBy}`,
          `ORDER BY SUM(${firstMetricExprFor(columnDimensions)}) DESC`,
          `LIMIT ${limitOpts.limitCols}`
        ].filter(Boolean).join('\n  ')
        flatCtes.push({ name: '_top_cols', body: `  ${cte}` })

        const colCols = columnDimensions.map(d => this.resolveDimExpr(d, preAggregated)).join(', ')
        const colAliases = columnDimensions.map(d => quoteIdent(d)).join(', ')
        flatFilters.push(`(${colCols}) IN (SELECT ${colAliases} FROM _top_cols)`)
      }
    }

    // ============ INNER QUERY ============
    // Aggregate by requested dims + hidden time dims (finest grain).
    // Deduplicate by (sourceField, aggregation) — multiple measures sharing both
    // produce one inner column, differentiated by timeAggregation in the middle query.
    //
    // Time source columns use parseExpression (if configured) so the inner query
    // outputs DATE values. All downstream references (weight expressions, ARG_MAX)
    // then get DATE semantics without needing additional casts.
    const timeSourceColumns = new Set((this.schema.timeDimensions ?? []).map(t => t.sourceColumn))
    const innerDims = [...allDimensions, ...hiddenQualifierDims, ...timeDims]
    const innerSelectParts: string[] = innerDims.map(d => {
      const dimExpr = timeSourceColumns.has(d) ? this.resolveTimeDimExpr(d, preAggregated) : this.resolveDimExpr(d, preAggregated)
      return dimExpr !== quoteIdent(d) ? `${dimExpr} AS ${quoteIdent(d)}` : dimExpr
    })
    const aggsBySource = new Map<string, Set<string>>()
    for (const m of measures) {
      const agg = safeAgg(m.aggregation || 'sum')
      if (!aggsBySource.has(m.sourceField)) aggsBySource.set(m.sourceField, new Set())
      aggsBySource.get(m.sourceField)!.add(agg)
    }
    const innerAliasMap = new Map<string, string>()
    const seenKeys = new Set<string>()
    for (const m of measures) {
      const agg = safeAgg(m.aggregation || 'sum')
      const key = `${m.sourceField}\0${agg}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)
      const needsDisambig = aggsBySource.get(m.sourceField)!.size > 1
      const alias = needsDisambig ? `${m.sourceField}__${agg.toLowerCase()}` : m.sourceField
      innerAliasMap.set(key, alias)
      const fieldExpr = this.resolveMeasureExpr(m, preAggregated, new Set(innerDims))
      innerSelectParts.push(`CAST(${agg}(${fieldExpr}) AS DOUBLE) AS ${quoteIdent(alias)}`)
    }

    // Combine user filters with flat mode WHERE IN filters
    const userConditions = this.buildWhereConditions(filters, preAggregated)
    const allConditions = [...userConditions, ...flatFilters]
    const innerWhere = allConditions.length > 0 ? `WHERE ${allConditions.join('\n  AND ')}` : ''

    // Add sort columns for dims with sortExpression
    innerSelectParts.push(...this.getSortSelectParts(allDimensions, preAggregated))

    const innerGroupBy = innerDims.map(d =>
      timeSourceColumns.has(d) ? this.resolveTimeDimExpr(d, preAggregated) : this.resolveDimExpr(d, preAggregated)
    ).join(', ')
    const innerQuery = [
      `SELECT ${innerSelectParts.join(', ')}`,
      `FROM ${quoteIdent(source)}`,
      innerWhere,
      `GROUP BY ${innerGroupBy}`
    ].filter(Boolean).join('\n    ')

    // ============ TIME DIMS ON AXES: CTE + UNION ALL ============
    // When time-derived dims appear on an axis and stock measures exist,
    // the ROLLUP can't use plain SUM — it must use the correct time aggregation
    // (weighted_avg, eop) when collapsing time dims. The CTE + UNION ALL approach
    // pre-computes each collapse level with the right formula.
    // Long-form mode also uses this path (stock/flow driven by qualifier dimension values).
    const hasStockMeasures = measures.some(m => m.timeAggregation && m.timeAggregation !== 'flow')
    const needsTimeRouting = hasStockMeasures || this.isLongFormMode()
    const timeRowDimSet = new Set(
      needsTimeRouting ? rowDimensions.filter(d => this.isTimeDerivedDim(d)) : []
    )
    const hasTimeRowDims = timeRowDimSet.size > 0

    if (hasTimeColDims || hasTimeRowDims) {
      return this.buildTimeCteRollup(
        rowDimensions, columnDimensions, allDimensions, measures,
        timeColDimSet, timeRowDimSet, innerQuery, innerAliasMap, flatCtes, hiddenQualifierDims,
        preAggregated
      )
    }

    // ============ MIDDLE QUERY (no time col dims) ============
    // Collapse hidden time dims only. All requested dims + hidden qualifier dims stay in GROUP BY.
    // Hidden qualifier dims are in GROUP BY so the long-form CASE WHEN can reference them,
    // but not in SELECT — the outer ROLLUP aggregates across qualifier values.
    const middleGroupDims = [...allDimensions, ...hiddenQualifierDims]
    const middleSelectParts: string[] = allDimensions.map(d => quoteIdent(d))

    const weightExpr = this.buildWeightExpression(true)
    const timeSourceCol = this.getTimeSourceColumn()

    const { exprs: middleMeasureExprs, measureFields: mFields } =
      this.buildMiddleMeasureExprs(measures, innerAliasMap, weightExpr, timeSourceCol)
    middleSelectParts.push(...middleMeasureExprs)
    measureFields.push(...mFields)

    // Carry sort columns through middle query
    middleSelectParts.push(...this.getSortPassthroughParts(allDimensions, preAggregated))

    const middleGroupBy = middleGroupDims.length > 0
      ? `GROUP BY ${middleGroupDims.map(d => quoteIdent(d)).join(', ')}`
      : ''

    const middleQuery = [
      `SELECT ${middleSelectParts.join(', ')}`,
      `FROM (\n    ${innerQuery}\n  ) AS _inner`,
      middleGroupBy
    ].filter(Boolean).join('\n  ')

    // ============ OUTER QUERY (no time col dims) ============
    const outerSelectParts: string[] = []

    for (const dim of allDimensions) {
      const gCol = `_g_${dim}`
      groupingColumns.push(gCol)
      outerSelectParts.push(`GROUPING(${quoteIdent(dim)}) AS ${quoteIdent(gCol)}`)
    }

    for (const dim of allDimensions) {
      outerSelectParts.push(quoteIdent(dim))
    }

    for (const m of measures) {
      const ref = quoteIdent(m.id)
      const ta = m.timeAggregation || 'flow'
      let outerAgg = 'SUM'
      if (ta === 'flow') {
        const agg = safeAgg(m.aggregation || 'sum')
        if (agg === 'MIN' || agg === 'MAX') outerAgg = agg
      }
      outerSelectParts.push(`${outerAgg}(${ref}) AS ${ref}`)
    }

    const outerGroupBy = this.buildRollupGroupBy(rowDimensions, columnDimensions, true)

    // Carry sort columns out of the outer query too, so a wrapper above it can
    // order by the same key by name.
    outerSelectParts.push(...this.getSortPassthroughParts(allDimensions, preAggregated))

    const orderParts: string[] = []
    for (const dim of allDimensions) {
      orderParts.push(`GROUPING(${quoteIdent(dim)})`)
      orderParts.push(this.resolveSortExpr(dim, preAggregated, true))
    }
    const orderByClause = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

    const mainQuery = [
      `SELECT ${outerSelectParts.join(', ')}`,
      `FROM (\n  ${middleQuery}\n) AS _time_collapsed`,
      outerGroupBy,
    ].filter(Boolean).join('\n')

    return {
      ctes: flatCtes,
      mainQuery,
      orderBy: orderByClause,
      groupingColumns,
      dimensionFields: allDimensions,
      rowDimensionCount: rowDimensions.length,
      measureFields,
      sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated)
    }
  }

  /**
   * Wrap a ROLLUP query as a CTE and add percentage columns via window functions.
   * The denominator for each mode is found by filtering on GROUPING() columns:
   *   pct_row: row total = where all col groupings = 1, partitioned by row dims
   *   pct_col: col total = where all row groupings = 1, partitioned by col dims
   *   pct_total: grand total = where all groupings = 1
   */
  private wrapWithPercentages(
    base: RollupParts,
    mode: 'pct_row' | 'pct_col' | 'pct_total',
    rowDimensions: string[],
    columnDimensions: string[]
  ): RollupParts {
    const allDimensions = [...rowDimensions, ...columnDimensions.filter(d => !rowDimensions.includes(d))]

    // Build percentage columns (skip derived measure fields — their values are already
    // comparison results like YoY%, so a percentage-of-percentage makes no sense)
    const pctSelectParts: string[] = []
    const percentageFields: string[] = []
    const derivedSet = new Set(base.derivedMeasureFields ?? [])

    for (const mf of base.measureFields) {
      if (derivedSet.has(mf)) continue
      const pctCol = `${mf}_pct`
      percentageFields.push(pctCol)
      const ref = quoteIdent(mf)

      let denomExpr: string
      switch (mode) {
        case 'pct_row': {
          // Denominator: value where all column groupings = 1 (= row total)
          const cond = columnDimensions.length > 0
            ? columnDimensions.map(d => `${quoteIdent(`_g_${d}`)} = 1`).join(' AND ')
            : '1=1'
          const parts = rowDimensions.flatMap(d => [quoteIdent(`_g_${d}`), quoteIdent(d)])
          const partition = parts.length > 0 ? `PARTITION BY ${parts.join(', ')}` : ''
          denomExpr = `SUM(CASE WHEN ${cond} THEN ${ref} END) OVER (${partition})`
          break
        }
        case 'pct_col': {
          // Denominator: value where all row groupings = 1 (= column total)
          const cond = rowDimensions.length > 0
            ? rowDimensions.map(d => `${quoteIdent(`_g_${d}`)} = 1`).join(' AND ')
            : '1=1'
          const parts = columnDimensions.flatMap(d => [quoteIdent(`_g_${d}`), quoteIdent(d)])
          const partition = parts.length > 0 ? `PARTITION BY ${parts.join(', ')}` : ''
          denomExpr = `SUM(CASE WHEN ${cond} THEN ${ref} END) OVER (${partition})`
          break
        }
        case 'pct_total': {
          // Denominator: grand total (all groupings = 1)
          const cond = allDimensions.length > 0
            ? allDimensions.map(d => `${quoteIdent(`_g_${d}`)} = 1`).join(' AND ')
            : '1=1'
          denomExpr = `SUM(CASE WHEN ${cond} THEN ${ref} END) OVER ()`
          break
        }
      }

      pctSelectParts.push(
        `CASE WHEN ${ref} IS NOT NULL AND ${ref} != 0`
        + ` THEN ${ref} / NULLIF(${denomExpr}, 0) * 100`
        + ` ELSE NULL END AS ${quoteIdent(pctCol)}`
      )
    }

    // Outer ORDER BY using column aliases (not GROUPING() calls).
    // Only a sort column the base query actually emitted can be named here.
    const baseSortCols = new Set(base.sortColumns ?? [])
    const orderParts: string[] = []
    for (const dim of allDimensions) {
      orderParts.push(quoteIdent(`_g_${dim}`))
      orderParts.push(baseSortCols.has(dim) ? quoteIdent('_sort_' + dim) : quoteIdent(dim))
    }
    const orderBy = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

    return {
      ctes: [...base.ctes, { name: '_rollup', body: base.mainQuery }],
      mainQuery: `SELECT *, ${pctSelectParts.join(', ')}\nFROM _rollup`,
      orderBy,
      groupingColumns: base.groupingColumns,
      dimensionFields: base.dimensionFields,
      rowDimensionCount: base.rowDimensionCount,
      measureFields: base.measureFields,
      percentageFields,
      ...(base.derivedMeasureFields?.length ? { derivedMeasureFields: base.derivedMeasureFields } : {}),
      ...(base.sortColumns?.length ? { sortColumns: base.sortColumns } : {}),
    }
  }

  /**
   * Wrap a ROLLUP result with comparison formula (derived) measures.
   *
   * Derived measures use window functions that require the full grouped result
   * to be available — they cannot run inside the ROLLUP itself. This method:
   *   1. Wraps the existing query as a CTE (_base)
   *   2. Creates a _derived CTE containing all rows except the grand total,
   *      with each derived expression computed as a window function. Grouping
   *      columns (_g_*) are injected into OVER() partitions so that different
   *      rollup levels never mix in window computations.
   *   3. LEFT JOINs _derived back onto _base, matching on _g_* columns and
   *      dimension values. Grand-total rows get NULL (no match in _derived).
   *
   * Must run BEFORE wrapWithPercentages (so percentages skip derived fields) and
   * BEFORE addTrueTotals (so true-total rows also get NULL for derived measures).
   */
  private wrapWithDerivedMeasures(
    base: RollupParts,
    derivedMeasures: MeasureDefinition[]
  ): RollupParts {
    if (derivedMeasures.length === 0) return base

    const allDimensions = base.dimensionFields
    const groupingCols = allDimensions.map(d => `_g_${d}`)

    // Grand total: all GROUPING() columns = 1
    const isGrandTotal = allDimensions.length > 0
      ? allDimensions.map(d => `${quoteIdent(`_g_${d}`)} = 1`).join(' AND ')
      : '1=0'  // no dimensions → no grand total to exclude

    // _derived CTE: all rows except grand total, with derived expressions
    const baseMeasureIds = new Set(base.measureFields)
    const derivedSelectParts: string[] = ['*']
    const derivedMeasureFields: string[] = []
    for (const m of derivedMeasures) {
      if (!m.derivedExpression || !isValidSqlExpression(m.derivedExpression)) {
        throw new Error(`Derived measure "${m.id}" requires a valid derivedExpression`)
      }
      // Validate declared dependencies are present in _base
      for (const depId of (m.dependsOn ?? [])) {
        if (!baseMeasureIds.has(depId)) {
          throw new Error(
            `Derived measure "${m.id}" depends on "${depId}" but it is not in the query. ` +
            `Add "${depId}" to the measures list or declare it in dependsOn.`
          )
        }
      }
      // Expand $DIMS(dimId) → quoted list of all query dimensions except dimId
      let expr = expandDimsVariable(m.derivedExpression, allDimensions)
      // Inject grouping columns into OVER() partitions so different rollup
      // levels are isolated from each other in window computations
      expr = injectGroupingPartition(expr, groupingCols)
      derivedSelectParts.push(`CAST((${expr}) AS DOUBLE) AS ${quoteIdent(m.id)}`)
      derivedMeasureFields.push(m.id)
    }

    const derivedBody = `SELECT ${derivedSelectParts.join(', ')}\nFROM _base\nWHERE NOT (${isGrandTotal})`

    // JOIN condition: match on _g_* columns (grouping level) AND dimension values
    const joinCondStr = [
      ...allDimensions.map(d => `r.${quoteIdent(`_g_${d}`)} = l.${quoteIdent(`_g_${d}`)}`),
      ...allDimensions.map(d => `r.${quoteIdent(d)} IS NOT DISTINCT FROM l.${quoteIdent(d)}`)
    ].join('\n  AND ')

    const derivedCols = derivedMeasures.map(m => `l.${quoteIdent(m.id)}`).join(', ')

    const mainQuery = [
      `SELECT r.*, ${derivedCols}`,
      `FROM _base r`,
      `LEFT JOIN _derived l ON (${joinCondStr})`,
    ].join('\n')

    // Rebuild ORDER BY using r. prefix to avoid ambiguity — both _base r and _derived l
    // have identical dim and _g_X columns (_derived SELECTs * from _base). GROUPING() calls
    // also can't be used here since the outer query has no GROUP BY.
    const baseSortCols = new Set(base.sortColumns ?? [])
    const orderParts: string[] = []
    for (const dim of allDimensions) {
      orderParts.push(`r.${quoteIdent(`_g_${dim}`)}`)
      orderParts.push(baseSortCols.has(dim) ? `r.${quoteIdent('_sort_' + dim)}` : `r.${quoteIdent(dim)}`)
    }
    const orderBy = orderParts.length > 0 ? `ORDER BY ${orderParts.join(', ')}` : ''

    return {
      ctes: [...base.ctes, { name: '_base', body: base.mainQuery }, { name: '_derived', body: derivedBody }],
      mainQuery,
      orderBy,
      groupingColumns: base.groupingColumns,
      dimensionFields: base.dimensionFields,
      rowDimensionCount: base.rowDimensionCount,
      measureFields: [...base.measureFields, ...derivedMeasureFields],
      derivedMeasureFields,
      ...(base.percentageFields ? { percentageFields: base.percentageFields } : {}),
      ...(base.displayColumns?.length ? { displayColumns: base.displayColumns } : {}),
      ...(base.sortColumns?.length ? { sortColumns: base.sortColumns } : {}),
    }
  }

  /**
   * Add true total CTEs and UNION ALL rows to a ROLLUP query.
   * True totals are computed from the source with user filters only (no top-N filtering).
   * This allows the UI to calculate <Other> values (difference between true totals
   * and the displayed top-N totals).
   *
   * Adds a _tt marker column: 0=normal ROLLUP, 1=true grand total,
   * 2=true row subtotal, 3=true col subtotal.
   */
  private addTrueTotals(
    base: RollupParts,
    measures: MeasureDefinition[],
    filters: Filter[],
    source: string,
    preAggregated: boolean,
    limitOpts: LimitOpts,
    rowDimensions: string[],
    columnDimensions: string[]
  ): RollupParts {
    const allDimensions = base.dimensionFields
    const ctes = [...base.ctes]

    // Stock measures with time dimensions need two-pass true totals:
    // first collapse time per entity, then SUM across entities.
    // Without this, the true total computes a global average instead of
    // the sum of per-entity time-averaged values.
    const hasStock = measures.some(m => m.timeAggregation && m.timeAggregation !== 'flow')
    const timeSrcCols = (this.schema.timeDimensions ?? []).map(td => td.sourceColumn)
    const needsTwoPass = hasStock && timeSrcCols.length > 0

    const weightExpr = this.buildWeightExpression(false)
    const timeSourceCol = this.getTimeSourceColumn()

    // Build stock-aware aggregation expressions (weighted_avg, eop, flow)
    const buildStockAggs = (resolve: (m: MeasureDefinition) => string): string[] =>
      measures.map(m => {
        const fieldExpr = resolve(m)
        const ta = m.timeAggregation || 'flow'
        let aggExpr: string
        switch (ta) {
          case 'weighted_avg':
            aggExpr = `SUM(${fieldExpr} * ${weightExpr}) / NULLIF(SUM(${weightExpr}), 0)`
            break
          case 'eop':
            aggExpr = timeSourceCol
              ? `ARG_MAX(${fieldExpr}, ${this.resolveTimeDimExpr(timeSourceCol)})`
              : `MAX(${fieldExpr})`
            break
          default: {
            if (m.aggregation === 'custom') {
              // Custom expression already contains its own aggregation — use as-is
              aggExpr = fieldExpr
            } else {
              const agg = safeAgg(m.aggregation || 'sum')
              aggExpr = `${agg}(${fieldExpr})`
            }
            break
          }
        }
        return `CAST(${aggExpr} AS DOUBLE) AS ${quoteIdent(m.id)}`
      })

    // When two-pass: _true_entity CTE collapses time per entity,
    // then true total CTEs use simple SUM from _true_entity.
    // When single-pass: true total CTEs aggregate directly from source.
    let ttSource: string
    // A function rather than an array: the same aggregates go into three CTEs
    // that group by nothing, by the rows, and by the columns.
    let measureAggsFor: (groupedDims: Set<string>) => string[]
    let resolveTTDim: (d: string) => string
    let getTTUserConditions: () => string[]

    if (needsTwoPass) {
      const entityDims = [...new Set([...rowDimensions, ...columnDimensions])]
      const entitySelectParts = entityDims.map(d => {
        const expr = this.resolveDimExpr(d, preAggregated)
        const alias = quoteIdent(d)
        return expr !== alias ? `${expr} AS ${alias}` : alias
      })
      const entityGroupBy = entityDims.map(d => this.resolveDimExpr(d, preAggregated))
      const entityMeasureAggs = buildStockAggs(m => this.resolveMeasureExpr(m, preAggregated, new Set(entityDims)))
      const whereClause = this.buildWhereClause(filters, preAggregated)

      const entityCte = [
        `SELECT ${[...entitySelectParts, ...entityMeasureAggs].join(', ')}`,
        `FROM ${quoteIdent(source)}`,
        whereClause,
        entityGroupBy.length > 0 ? `GROUP BY ${entityGroupBy.join(', ')}` : '',
      ].filter(Boolean).join('\n  ')
      ctes.push({ name: '_true_entity', body: `  ${entityCte}` })

      ttSource = '_true_entity'
      measureAggsFor = () => measures.map(m => {
        const agg = safeAgg(m.aggregation || 'sum')
        return `CAST(${agg}(${quoteIdent(m.id)}) AS DOUBLE) AS ${quoteIdent(m.id)}`
      })
      resolveTTDim = d => quoteIdent(d)
      getTTUserConditions = () => []  // already applied in entity CTE
    } else {
      ttSource = quoteIdent(source)
      measureAggsFor = g => buildStockAggs(m => this.resolveMeasureExpr(m, preAggregated, g))
      resolveTTDim = d => this.resolveDimExpr(d, preAggregated)
      getTTUserConditions = () => this.buildWhereConditions(filters, preAggregated)
    }

    // _true_total CTE: grand total with user filters only
    const ttUserConditions = getTTUserConditions()
    const ttWhere = ttUserConditions.length > 0 ? `WHERE ${ttUserConditions.join('\n  AND ')}` : ''
    const trueTotalCte = [
      `SELECT ${measureAggsFor(QueryBuilder.NO_GROUPING).join(', ')}`,
      `FROM ${ttSource}`,
      ttWhere,
    ].filter(Boolean).join('\n  ')
    ctes.push({ name: '_true_total', body: `  ${trueTotalCte}` })

    // _true_row_totals CTE: row subtotals across all columns (only when limitCols active)
    const hasRowTotals = limitOpts.limitCols && columnDimensions.length > 0 && rowDimensions.length > 0
    if (hasRowTotals) {
      const rowExprs = rowDimensions.map(d => {
        const expr = resolveTTDim(d)
        return { dim: d, expr, alias: quoteIdent(d) }
      })
      const selectParts = rowExprs.map(r => r.expr !== r.alias ? `${r.expr} AS ${r.alias}` : r.alias)
      const groupBy = rowExprs.map(r => r.expr).join(', ')
      // Filter to top-N rows only (we want true totals for the displayed rows, across ALL columns)
      const rowFilterParts: string[] = []
      if (limitOpts.limitRows) {
        const rowCols = rowDimensions.map(d => resolveTTDim(d)).join(', ')
        const rowAliases = rowDimensions.map(d => quoteIdent(d)).join(', ')
        rowFilterParts.push(`(${rowCols}) IN (SELECT ${rowAliases} FROM _top_rows)`)
      }
      const userConditions = getTTUserConditions()
      const allConditions = [...userConditions, ...rowFilterParts]
      const rowWhere = allConditions.length > 0 ? `WHERE ${allConditions.join('\n  AND ')}` : ''
      const cte = [
        `SELECT ${[...selectParts, ...measureAggsFor(new Set(rowDimensions))].join(', ')}`,
        `FROM ${ttSource}`,
        rowWhere,
        `GROUP BY ${groupBy}`,
      ].filter(Boolean).join('\n  ')
      ctes.push({ name: '_true_row_totals', body: `  ${cte}` })
    }

    // _true_col_totals CTE: col subtotals across all rows (only when limitRows active)
    const hasColTotals = limitOpts.limitRows && rowDimensions.length > 0 && columnDimensions.length > 0
    if (hasColTotals) {
      const colExprs = columnDimensions.map(d => {
        const expr = resolveTTDim(d)
        return { dim: d, expr, alias: quoteIdent(d) }
      })
      const selectParts = colExprs.map(c => c.expr !== c.alias ? `${c.expr} AS ${c.alias}` : c.alias)
      const groupBy = colExprs.map(c => c.expr).join(', ')
      // Filter to top-N cols only (true totals for displayed cols, across ALL rows)
      const colFilterParts: string[] = []
      if (limitOpts.limitCols) {
        const colCols = columnDimensions.map(d => resolveTTDim(d)).join(', ')
        const colAliases = columnDimensions.map(d => quoteIdent(d)).join(', ')
        colFilterParts.push(`(${colCols}) IN (SELECT ${colAliases} FROM _top_cols)`)
      }
      const userConditions = getTTUserConditions()
      const allConditions = [...userConditions, ...colFilterParts]
      const colWhere = allConditions.length > 0 ? `WHERE ${allConditions.join('\n  AND ')}` : ''
      const cte = [
        `SELECT ${[...selectParts, ...measureAggsFor(new Set(columnDimensions))].join(', ')}`,
        `FROM ${ttSource}`,
        colWhere,
        `GROUP BY ${groupBy}`,
      ].filter(Boolean).join('\n  ')
      ctes.push({ name: '_true_col_totals', body: `  ${cte}` })
    }

    // Build UNION ALL SELECT statements for each true total type.
    // Wrap the base query (with its ORDER BY) as a subquery to preserve row ordering,
    // then UNION ALL the true total rows. The _tt column marks row type:
    // 0=normal ROLLUP, 1=true grand total, 2=true row subtotal, 3=true col subtotal.

    // Assemble the base query as it would normally appear (mainQuery + orderBy)
    const baseQueryFull = [base.mainQuery, base.orderBy].filter(Boolean).join('\n')

    // Helper: build a true total SELECT with NULLs for missing columns
    const buildTrueSelect = (tt: number, dimParts: string[], fromTable: string): string => {
      const parts: string[] = [`${tt} AS _tt`]
      // Grouping columns: NULL (cast to integer for type consistency)
      for (const gc of base.groupingColumns) parts.push(`CAST(NULL AS INTEGER) AS ${quoteIdent(gc)}`)
      // Dimension columns
      parts.push(...dimParts)
      // Measure columns from the CTE
      for (const m of measures) parts.push(quoteIdent(m.id))
      // Percentage columns: NULL
      if (base.percentageFields) {
        for (const pf of base.percentageFields) parts.push(`CAST(NULL AS DOUBLE) AS ${quoteIdent(pf)}`)
      }
      if (base.derivedMeasureFields) {
        for (const df of base.derivedMeasureFields) parts.push(`CAST(NULL AS DOUBLE) AS ${quoteIdent(df)}`)
      }
      // Sort columns exist in the ROLLUP half of the UNION, so the true-total half
      // has to name them too or the two sides disagree on column count.
      if (base.sortColumns) {
        for (const sc of base.sortColumns) parts.push(`NULL AS ${quoteIdent('_sort_' + sc)}`)
      }
      return `SELECT ${parts.join(', ')} FROM ${fromTable}`
    }

    // Grand total: all dims NULL
    const grandDimNulls = allDimensions.map(d => `NULL AS ${quoteIdent(d)}`)
    const grandSelect = buildTrueSelect(1, grandDimNulls, '_true_total')

    // Row subtotals: row dims from CTE, col dims NULL
    let rowSelect = ''
    if (hasRowTotals) {
      const rowDimParts = allDimensions.map(d =>
        rowDimensions.includes(d) ? quoteIdent(d) : `NULL AS ${quoteIdent(d)}`
      )
      rowSelect = buildTrueSelect(2, rowDimParts, '_true_row_totals')
    }

    // Col subtotals: col dims from CTE, row dims NULL
    let colSelect = ''
    if (hasColTotals) {
      const colDimParts = allDimensions.map(d =>
        columnDimensions.includes(d) ? quoteIdent(d) : `NULL AS ${quoteIdent(d)}`
      )
      colSelect = buildTrueSelect(3, colDimParts, '_true_col_totals')
    }

    // Build the combined query: base ROLLUP (wrapped with _tt=0) UNION ALL true totals
    let mainQuery = `SELECT 0 AS _tt, _base.* FROM (\n${baseQueryFull}\n) AS _base`
    mainQuery += `\nUNION ALL\n${grandSelect}`
    if (rowSelect) mainQuery += `\nUNION ALL\n${rowSelect}`
    if (colSelect) mainQuery += `\nUNION ALL\n${colSelect}`

    return {
      ctes,
      mainQuery,
      orderBy: '',  // ORDER BY is inside the _base subquery; true total rows appear at end
      groupingColumns: base.groupingColumns,
      dimensionFields: base.dimensionFields,
      rowDimensionCount: base.rowDimensionCount,
      measureFields: base.measureFields,
      ...(base.percentageFields ? { percentageFields: base.percentageFields } : {}),
      ...(base.derivedMeasureFields?.length ? { derivedMeasureFields: base.derivedMeasureFields } : {}),
      ...(base.sortColumns?.length ? { sortColumns: base.sortColumns } : {}),
    }
  }

  /**
   * Add display lookup CTEs and LEFT JOINs for dimensions with descriptionField.
   * Wraps the existing query as _pre_display, adds _lookup_<field> CTEs,
   * and produces a final SELECT with __display columns via LEFT JOIN.
   * Only joins on detail rows (where _g_<field> = 0) to avoid matching subtotals.
   */
  private addDisplayLookups(
    base: RollupParts,
    allDimensions: string[],
    source: string,
    preAggregated: boolean
  ): RollupParts {
    // Find dimensions that have descriptionField set
    const lookupDims: { field: string; descField: string; lookupExpr: string }[] = []
    for (const dim of allDimensions) {
      const def = this.schema.dimensions.find(d => d.sourceField === dim)
                || this.schema.dimensions.find(d => d.id === dim)
      if (!def?.descriptionField || def.descriptionField === dim) continue

      // For derived dimensions (expression-based), the lookup SELECT DISTINCT
      // needs the expression, not the raw field name. But for preAggregated sources,
      // the column is already materialised.
      const lookupExpr = this.resolveDimExpr(dim, preAggregated)
      lookupDims.push({ field: dim, descField: def.descriptionField, lookupExpr })
    }

    if (lookupDims.length === 0) return base

    const ctes = [...base.ctes]

    // Add lookup CTEs — each does SELECT DISTINCT code, MIN(name) FROM source
    for (const { field, descField, lookupExpr } of lookupDims) {
      const cteName = quoteIdent(`_lookup_${field}`)
      const descExpr = quoteIdent(descField)
      const cteBody = `  SELECT ${lookupExpr} AS _code, MIN(${descExpr}) AS _name FROM ${quoteIdent(source)}`
        + `\n  GROUP BY ${lookupExpr}`
      ctes.push({ name: cteName, body: cteBody })
    }

    // Wrap the base query (mainQuery + orderBy) as _pre_display CTE
    const baseQueryFull = [base.mainQuery, base.orderBy].filter(Boolean).join('\n')
    ctes.push({ name: '_pre_display', body: baseQueryFull })

    // Build the outer SELECT: _pre_display.*, plus __display columns from lookups
    const displayColumns: { field: string; column: string }[] = []
    const joinClauses: string[] = []
    const selectParts = ['_pre_display.*']

    for (let i = 0; i < lookupDims.length; i++) {
      const { field } = lookupDims[i]
      const alias = `_lr${i}`
      const displayCol = `${field}__display`
      displayColumns.push({ field, column: displayCol })

      selectParts.push(`${alias}._name AS ${quoteIdent(displayCol)}`)

      const gCol = `_g_${field}`
      joinClauses.push(
        `LEFT JOIN ${quoteIdent(`_lookup_${field}`)} ${alias}`
        + ` ON _pre_display.${quoteIdent(field)} = ${alias}._code`
        + ` AND _pre_display.${quoteIdent(gCol)} = 0`
      )
    }

    const mainQuery = [
      `SELECT ${selectParts.join(', ')}`,
      `FROM _pre_display`,
      ...joinClauses
    ].join('\n')

    return {
      ctes,
      mainQuery,
      orderBy: '',  // ORDER BY is inside _pre_display
      groupingColumns: base.groupingColumns,
      dimensionFields: base.dimensionFields,
      rowDimensionCount: base.rowDimensionCount,
      measureFields: base.measureFields,
      ...(base.percentageFields ? { percentageFields: base.percentageFields } : {}),
      ...(base.derivedMeasureFields?.length ? { derivedMeasureFields: base.derivedMeasureFields } : {}),
      ...(base.sortColumns?.length ? { sortColumns: base.sortColumns } : {}),
      displayColumns
    }
  }

  private buildRollupGroupBy(rowDimensions: string[], columnDimensions: string[], useRawIdents = false, preAggregated = false): string {
    if (rowDimensions.length === 0 && columnDimensions.length === 0) return ''

    const resolve = useRawIdents ? quoteIdent : (d: string) => this.resolveDimExpr(d, preAggregated)
    const parts: string[] = []
    if (rowDimensions.length > 0) {
      parts.push(`ROLLUP(${rowDimensions.map(resolve).join(', ')})`)
    }
    // Column dims that also appear on rows are already handled by the ROLLUP —
    // including them in a separate GROUPING SETS creates a cross-product that
    // duplicates every row.  Only emit GROUPING SETS for column-only dims.
    const colOnly = columnDimensions.filter(d => !rowDimensions.includes(d))
    if (colOnly.length > 0) {
      const colExprs = colOnly.map(resolve).join(', ')
      parts.push(`GROUPING SETS((${colExprs}), ())`)
    }
    return `GROUP BY ${parts.join(', ')}`
  }

  /**
   * Build a ROLLUP query for time-derived dims on one or both axes.
   * Uses CTE + UNION ALL so the outer query can use a single ROLLUP(all_col_dims),
   * producing only contiguous grouping patterns the parser can handle.
   *
   * Middle layer: UNION ALL of detail rows and time-total rows at each collapse level.
   * Outer layer: CASE on GROUPING() to select the right _ttl level per ROLLUP tier.
   *
   * When only one axis has time dims, the other axis contributes a single trivial
   * level [[]], making the cartesian product degenerate to the single-axis case.
   */
  private buildTimeCteRollup(
    rowDimensions: string[],
    columnDimensions: string[],
    allDimensions: string[],
    measures: MeasureDefinition[],
    timeColDimSet: Set<string>,
    timeRowDimSet: Set<string>,
    innerQuery: string,
    innerAliasMap: Map<string, string>,
    flatCtes: { name: string; body: string }[] = [],
    hiddenQualifierDims: string[] = [],
    preAggregated = false
  ): RollupParts {
    const groupingColumns: string[] = []
    const measureFields: string[] = []

    // Build collapse levels for each axis by walking dims from the end.
    // Each time dim encountered adds a new collapse level (matching ROLLUP suffix removal).
    // Level 0 = detail (no time dims collapsed). An empty dim set produces just [[]].
    const colTimeLevels: string[][] = [[]]
    const colAccum: string[] = []
    for (let i = columnDimensions.length - 1; i >= 0; i--) {
      if (timeColDimSet.has(columnDimensions[i])) {
        colAccum.push(columnDimensions[i])
        colTimeLevels.push([...colAccum])
      }
    }

    const rowTimeLevels: string[][] = [[]]
    const rowAccum: string[] = []
    for (let i = rowDimensions.length - 1; i >= 0; i--) {
      if (timeRowDimSet.has(rowDimensions[i])) {
        rowAccum.push(rowDimensions[i])
        rowTimeLevels.push([...rowAccum])
      }
    }

    // Cartesian product of collapse levels. When one axis has no time dims,
    // its levels array is just [[]], so the product degenerates to the other axis.
    const combinedLevels: Array<{ collapsed: Set<string>; ttl: number }> = []
    let ttl = 0
    for (let ci = 0; ci < colTimeLevels.length; ci++) {
      for (let ri = 0; ri < rowTimeLevels.length; ri++) {
        const collapsed = new Set([...colTimeLevels[ci], ...rowTimeLevels[ri]])
        combinedLevels.push({ collapsed, ttl: ttl++ })
      }
    }

    // Measure expressions for the UNION ALL segments (same formula for all levels;
    // only the GROUP BY differs, which controls what gets collapsed).
    const weightExpr = this.buildWeightExpression(true)
    const timeSourceCol = this.getTimeSourceColumn()
    const { exprs: middleMeasureExprs, measureFields: mFields } =
      this.buildMiddleMeasureExprs(measures, innerAliasMap, weightExpr, timeSourceCol)
    measureFields.push(...mFields)

    // Build UNION ALL segments: one per combined collapse level
    const unionSegments: string[] = []
    for (const level of combinedLevels) {
      const selectParts: string[] = []
      const groupByParts: string[] = []

      for (const dim of allDimensions) {
        if (level.collapsed.has(dim)) {
          selectParts.push(`NULL AS ${quoteIdent(dim)}`)
        } else {
          selectParts.push(quoteIdent(dim))
          groupByParts.push(quoteIdent(dim))
        }
      }
      // Hidden qualifier dims always stay in GROUP BY (never collapsed)
      for (const dim of hiddenQualifierDims) groupByParts.push(quoteIdent(dim))

      // Carry sort columns through — NULL for collapsed dims, MIN for others.
      // dimsWithSortColumn rather than the schema directly, so this agrees with
      // what the inner query actually emitted: a summary view emits none, and
      // referencing one it never produced fails at bind time.
      for (const dim of this.dimsWithSortColumn(allDimensions, preAggregated)) {
        const sortAlias = quoteIdent('_sort_' + dim)
        if (level.collapsed.has(dim)) {
          selectParts.push(`NULL AS ${sortAlias}`)
        } else {
          selectParts.push(`MIN(${sortAlias}) AS ${sortAlias}`)
        }
      }

      selectParts.push(...middleMeasureExprs)
      selectParts.push(`${level.ttl} AS _ttl`)

      const groupBy = groupByParts.length > 0
        ? `\n    GROUP BY ${groupByParts.join(', ')}`
        : ''

      unionSegments.push(
        `SELECT ${selectParts.join(', ')}\n    FROM _inner${groupBy}`
      )
    }

    // ============ OUTER QUERY ============
    const outerSelectParts: string[] = []

    // Grouping indicators
    for (const dim of allDimensions) {
      const gCol = `_g_${dim}`
      groupingColumns.push(gCol)
      outerSelectParts.push(`GROUPING(${quoteIdent(dim)}) AS ${quoteIdent(gCol)}`)
    }

    // Dimension columns
    for (const dim of allDimensions) {
      outerSelectParts.push(quoteIdent(dim))
    }

    // Measure columns: CASE on GROUPING of time dims to select correct _ttl level.
    // Process from most-collapsed to least-collapsed so the first matching WHEN wins.
    const sortedLevels = [...combinedLevels].sort((a, b) => b.collapsed.size - a.collapsed.size)
    for (const m of measures) {
      const ref = quoteIdent(m.id)
      const ta = m.timeAggregation || 'flow'
      let outerAgg = 'SUM'
      if (ta === 'flow') {
        const agg = safeAgg(m.aggregation || 'sum')
        if (agg === 'MIN' || agg === 'MAX') outerAgg = agg
      }

      const caseBranches: string[] = []
      for (const level of sortedLevels) {
        if (level.collapsed.size === 0) continue // handled by ELSE
        const cond = [...level.collapsed]
          .map(d => `GROUPING(${quoteIdent(d)}) = 1`).join(' AND ')
        caseBranches.push(
          `WHEN ${cond} THEN ${outerAgg}(CASE WHEN _ttl = ${level.ttl} THEN ${ref} END)`
        )
      }
      const detailLevel = combinedLevels.find(l => l.collapsed.size === 0)!
      const elseExpr = `${outerAgg}(CASE WHEN _ttl = ${detailLevel.ttl} THEN ${ref} END)`
      outerSelectParts.push(
        `CASE ${caseBranches.join(' ')} ELSE ${elseExpr} END AS ${ref}`
      )
    }

    // Carry sort columns out of the outer query so a wrapper above it can order
    // by the same key by name.
    outerSelectParts.push(...this.getSortPassthroughParts(allDimensions, preAggregated))

    // GROUP BY: ROLLUP for rows, GROUPING SETS for column-only dims
    const groupByParts: string[] = []
    if (rowDimensions.length > 0) {
      groupByParts.push(`ROLLUP(${rowDimensions.map(d => quoteIdent(d)).join(', ')})`)
    }
    const colOnlyDims = columnDimensions.filter(d => !rowDimensions.includes(d))
    if (colOnlyDims.length > 0) {
      const colExprs = colOnlyDims.map(d => quoteIdent(d)).join(', ')
      groupByParts.push(`GROUPING SETS((${colExprs}), ())`)
    }
    const outerGroupBy = groupByParts.length > 0
      ? `GROUP BY ${groupByParts.join(', ')}`
      : ''

    // HAVING: filter spurious NULL groups from both axes.
    // The UNION ALL's higher-_ttl segments set collapsed time dims to NULL.
    // ROLLUP treats these as real NULL groups (GROUPING=0), producing empty rows.
    const havingParts: string[] = []
    for (const dim of timeColDimSet) {
      havingParts.push(`(GROUPING(${quoteIdent(dim)}) = 1 OR ${quoteIdent(dim)} IS NOT NULL)`)
    }
    for (const dim of timeRowDimSet) {
      havingParts.push(`(GROUPING(${quoteIdent(dim)}) = 1 OR ${quoteIdent(dim)} IS NOT NULL)`)
    }
    const havingClause = havingParts.length > 0
      ? `HAVING ${havingParts.join(' AND ')}`
      : ''

    // ORDER BY
    const orderParts: string[] = []
    for (const dim of allDimensions) {
      orderParts.push(`GROUPING(${quoteIdent(dim)})`)
      orderParts.push(this.resolveSortExpr(dim, preAggregated, true))
    }
    const orderByClause = orderParts.length > 0
      ? `ORDER BY ${orderParts.join(', ')}`
      : ''

    const mainQuery = [
      `SELECT ${outerSelectParts.join(', ')}`,
      `FROM _mid`,
      outerGroupBy,
      havingClause,
    ].filter(Boolean).join('\n')

    return {
      ctes: [
        ...flatCtes,
        { name: '_inner', body: `  ${innerQuery}` },
        { name: '_mid', body: `  ${unionSegments.join('\n  UNION ALL\n  ')}` },
      ],
      mainQuery,
      orderBy: orderByClause,
      groupingColumns,
      dimensionFields: allDimensions,
      rowDimensionCount: rowDimensions.length,
      measureFields,
      // preAggregated, like every other caller: this is what later wrappers
      // trust when they pick a tie-break key, so claiming a sort column a
      // summary view never emitted fails at bind time one wrapper further out.
      sortColumns: this.dimsWithSortColumn(allDimensions, preAggregated)
    }
  }

  private granularityToInterval(granularity?: string): string {
    switch (granularity) {
      case 'day': return 'INTERVAL 1 DAY'
      case 'quarter': return 'INTERVAL 3 MONTH'
      case 'year': return 'INTERVAL 1 YEAR'
      default: return 'INTERVAL 1 MONTH'
    }
  }

  /** Check if the current schema is in long-form mode (has flow declarations). */
  private isLongFormMode(): boolean {
    return (this.schema.flowDeclarations?.length ?? 0) > 0
  }

  /**
   * Build the middle CTE measure expression for a single measure.
   * Handles both wide-form (per-measure timeAggregation) and long-form (CASE WHEN on qualifier).
   *
   * @param m The measure definition
   * @param innerRef Quoted reference to the inner query's column for this measure
   * @param weightExpr Weight expression for weighted_avg
   * @param timeSourceCol Time source column name for eop (ARG_MAX)
   * @returns SQL expression string (without trailing AS alias)
   */
  private buildMiddleMeasureExpr(
    m: MeasureDefinition,
    innerRef: string,
    weightExpr: string,
    timeSourceCol: string | undefined
  ): string {
    if (this.isLongFormMode()) {
      return this.buildLongFormMiddleMeasureExpr(m, innerRef, weightExpr)
    }
    return this.buildWideFormMiddleMeasureExpr(m, innerRef, weightExpr, timeSourceCol)
  }

  /** Wide-form: select formula based on measure's timeAggregation property. */
  private buildWideFormMiddleMeasureExpr(
    m: MeasureDefinition,
    innerRef: string,
    weightExpr: string,
    timeSourceCol: string | undefined
  ): string {
    const ta = m.timeAggregation || 'flow'
    switch (ta) {
      case 'flow': {
        const agg = safeAgg(m.aggregation || 'sum')
        const middleAgg = (agg === 'MIN' || agg === 'MAX') ? agg : 'SUM'
        return `${middleAgg}(${innerRef})`
      }
      case 'weighted_avg':
        return `SUM(${innerRef} * ${weightExpr}) / NULLIF(SUM(${weightExpr}), 0)`
      case 'eop':
        if (timeSourceCol) {
          return `ARG_MAX(${innerRef}, ${quoteIdent(timeSourceCol)})`
        }
        return `MAX(${innerRef})`
      default:
        return `SUM(${innerRef})`
    }
  }

  /**
   * Long-form: CASE WHEN on qualifier dimension to pick stock vs flow formula.
   * The qualifier dimension is in GROUP BY, so each group has one value.
   * The CASE picks the right aggregation formula based on that value.
   */
  private buildLongFormMiddleMeasureExpr(
    m: MeasureDefinition,
    innerRef: string,
    weightExpr: string
  ): string {
    const fds = this.schema.flowDeclarations ?? []
    const fd = fds.find(f => f.valueColumn === m.sourceField)
    if (!fd) {
      // No flow declaration for this measure — plain SUM (flow behavior)
      const agg = safeAgg(m.aggregation || 'sum')
      const middleAgg = (agg === 'MIN' || agg === 'MAX') ? agg : 'SUM'
      return `${middleAgg}(${innerRef})`
    }

    // Resolve the qualifier dimension's column reference.
    // In the middle CTE, we reference the inner query's output columns by their alias.
    // The qualifier dimension was included in the inner query's GROUP BY, so it's
    // available as a plain quoted identifier.
    const qualDim = this.schema.dimensions.find(d => d.id === fd.dimensionId)
    const qualField = qualDim?.sourceField ?? fd.dimensionId
    const qualRef = quoteIdent(qualField)

    const stockExpr = `SUM(${innerRef} * ${weightExpr}) / NULLIF(SUM(${weightExpr}), 0)`
    const flowExpr = `SUM(${innerRef})`

    // No stock values declared — everything is flow
    if (fd.stockValues.length === 0) return flowExpr
    // No flow values declared and no unclassified values possible — everything is stock
    // (but unclassified defaults to flow, so only use pure stock if flowValues is also empty
    //  and we trust the user classified everything)
    const stockList = fd.stockValues.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')
    return `CASE WHEN ${qualRef} IN (${stockList}) THEN ${stockExpr} ELSE ${flowExpr} END`
  }

  /**
   * Build middle CTE measure expressions for all measures.
   * Used by buildTwoPassRollup and the CTE rollup methods.
   *
   * @returns { exprs: SQL expressions with AS alias, measureFields: measure IDs }
   */
  private buildMiddleMeasureExprs(
    measures: MeasureDefinition[],
    innerAliasMap: Map<string, string>,
    weightExpr: string,
    timeSourceCol: string | undefined
  ): { exprs: string[]; measureFields: string[] } {
    const exprs: string[] = []
    const measureFields: string[] = []
    for (const m of measures) {
      const innerAlias = innerAliasMap.get(`${m.sourceField}\0${safeAgg(m.aggregation || 'sum')}`)!
      const innerRef = quoteIdent(innerAlias)
      const outputAlias = quoteIdent(m.id)
      measureFields.push(m.id)
      const expr = this.buildMiddleMeasureExpr(m, innerRef, weightExpr, timeSourceCol)
      exprs.push(`${expr} AS ${outputAlias}`)
    }
    return { exprs, measureFields }
  }

  /**
   * Build the weight expression for stock measure time-averaging, from the time declaration.
   * In the two-pass rollup, this is used in the middle query which reads from _inner
   * where the time column is already resolved. Pass middleQuery=true to use raw identifiers.
   */
  private buildWeightExpression(middleQuery = false): string {
    const tds = this.schema.timeDimensions ?? []
    if (tds.length === 0) return '1'
    const config = tds[0]
    if (config.stockWeighting === 'days') {
      const timeField = middleQuery ? quoteIdent(config.sourceColumn) : this.resolveTimeDimExpr(config.sourceColumn)
      const interval = this.granularityToInterval(config.granularity)
      return `DATE_DIFF('day', ${timeField}, ${timeField} + ${interval})`
    }
    return '1'  // months = equal weight per period
  }

  /** Get the time declaration's source column name (for ARG_MAX in EOP). */
  private getTimeSourceColumn(): string | undefined {
    const tds = this.schema.timeDimensions ?? []
    return tds.length > 0 ? tds[0].sourceColumn : undefined
  }

  /**
   * Resolve a time dimension's source column to its parse expression.
   * Returns parseExpression if configured (VARCHAR→DATE), otherwise the quoted column name.
   * Use this instead of resolveDimExpr when the column's role is "time dimension"
   * and downstream code needs DATE semantics (arithmetic, ordering).
   *
   * When preAggregated is true (querying a summary view), use the quoted column name —
   * the summary view has pre-computed the parse expression into a named column.
   */
  private resolveTimeDimExpr(sourceColumn: string, preAggregated = false): string {
    if (preAggregated) return quoteIdent(sourceColumn)
    const tds = this.schema.timeDimensions ?? []
    const config = tds.find(t => t.sourceColumn === sourceColumn)
    if (config?.parseExpression && isValidSqlExpression(config.parseExpression)) return config.parseExpression
    return quoteIdent(sourceColumn)
  }

  /** Check if a dimension is time-derived (is the time source column or derived from it). */
  private isTimeDerivedDim(dim: string): boolean {
    const tds = this.schema.timeDimensions ?? []
    const sourceColumns = new Set(tds.map(t => t.sourceColumn))
    if (sourceColumns.has(dim)) return true
    const def = this.schema.dimensions.find(d => d.sourceField === dim)
              || this.schema.dimensions.find(d => d.id === dim)
    return !!(def?.derivedFromField && sourceColumns.has(def.derivedFromField))
  }

  private findTimeDimensionsNotInGroup(requestedDims: string[]): string[] {
    const requested = new Set(requestedDims)
    return (this.schema.timeDimensions ?? [])
      .filter(td => !requested.has(td.sourceColumn))
      .map(td => td.sourceColumn)
  }

  private buildWhereConditions(filters: Filter[], preAggregated = false): string[] {
    return filters.map(f => {
      const qf = this.resolveDimExpr(f.field, preAggregated)
      switch (f.operator) {
        case '=':
          if (typeof f.value === 'string') {
            return `${qf} = '${this.escapeString(f.value)}'`
          } else {
            const n = Number(f.value)
            if (Number.isNaN(n)) { console.warn(`Filter '=' on ${f.field}: non-string value failed numeric validation`); return '' }
            return `${qf} = ${n}`
          }

        case 'in':
          if (Array.isArray(f.value)) {
            if (f.value.length === 0) return '1=0'
            const values = f.value.map(v => {
              if (typeof v === 'string') return `'${this.escapeString(v)}'`
              const n = Number(v)
              if (Number.isNaN(n)) { console.warn(`Filter 'in' on ${f.field}: non-string element failed numeric validation`); return null }
              return n
            }).filter(v => v !== null)
            if (values.length === 0) return '1=0'
            return `${qf} IN (${values.join(', ')})`
          }
          console.warn(`Filter 'in' on ${f.field}: expected array value, got ${typeof f.value}`)
          return ''

        case 'not_in':
          if (Array.isArray(f.value)) {
            if (f.value.length === 0) return '1=1'
            const values = f.value.map(v => {
              if (typeof v === 'string') return `'${this.escapeString(v)}'`
              const n = Number(v)
              if (Number.isNaN(n)) { console.warn(`Filter 'not_in' on ${f.field}: non-string element failed numeric validation`); return null }
              return n
            }).filter(v => v !== null)
            if (values.length === 0) return '1=1'
            return `${qf} NOT IN (${values.join(', ')})`
          }
          console.warn(`Filter 'not_in' on ${f.field}: expected array value, got ${typeof f.value}`)
          return ''

        case 'between':
          if (Array.isArray(f.value) && f.value.length === 2) {
            let lo: string | number, hi: string | number
            if (typeof f.value[0] === 'string') { lo = `'${this.escapeString(f.value[0])}'` }
            else { const n = Number(f.value[0]); if (Number.isNaN(n)) { console.warn(`Filter 'between' on ${f.field}: lo value failed numeric validation`); return '' } lo = n }
            if (typeof f.value[1] === 'string') { hi = `'${this.escapeString(f.value[1])}'` }
            else { const n = Number(f.value[1]); if (Number.isNaN(n)) { console.warn(`Filter 'between' on ${f.field}: hi value failed numeric validation`); return '' } hi = n }
            return `${qf} BETWEEN ${lo} AND ${hi}`
          }
          console.warn(`Filter 'between' on ${f.field}: expected [lo, hi] array, got ${JSON.stringify(f.value)}`)
          return ''

        case 'like':
          return `${qf} LIKE '${this.escapeString(String(f.value))}'`

        default:
          console.warn(`Unknown filter operator: ${(f as Filter).operator}`)
          return ''
      }
    }).filter(Boolean)
  }

  private buildWhereClause(filters: Filter[], preAggregated = false): string {
    const conditions = this.buildWhereConditions(filters, preAggregated)
    // In long-form mode, exclude values marked for exclusion
    if (this.isLongFormMode()) {
      for (const fd of this.schema.flowDeclarations!) {
        if (fd.excludeValues && fd.excludeValues.length > 0) {
          const qualDim = this.schema.dimensions.find(d => d.id === fd.dimensionId)
          const qualExpr = qualDim?.expression || quoteIdent(qualDim?.sourceField ?? fd.dimensionId)
          const excludeList = fd.excludeValues.map(v => `'${v.replace(/'/g, "''")}'`).join(', ')
          conditions.push(`${qualExpr} NOT IN (${excludeList})`)
        }
      }
    }
    return conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  }

  private escapeString(value: string): string {
    return value.replace(/'/g, "''")
  }

  getMeasure(id: string): MeasureDefinition | undefined {
    return this.schema.measures.find(m => m.id === id)
  }

  getNextLevel(hierarchy: string, currentLevel: string): string | null {
    const hier = this.schema.hierarchies.find(h => h.id === hierarchy)
    if (!hier) return null

    const levelFields = hier.levels.map(dimId => {
      const dim = this.schema.dimensions.find(d => d.id === dimId)
      return dim?.sourceField || dimId
    })

    const idx = levelFields.indexOf(currentLevel)
    if (idx === -1 || idx === levelFields.length - 1) return null

    return levelFields[idx + 1]
  }

}
