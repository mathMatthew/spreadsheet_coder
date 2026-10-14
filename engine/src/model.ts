/**
 * The semantic model and query types.
 *
 * A model describes one flat table: its dimensions (columns to group and filter
 * by), its measures (how each numeric column aggregates, including across time),
 * the hierarchies that order dimensions for drill-down, and the time columns.
 */

export interface FormatConfig {
  id: string
  name: string
  formatString: string
}

export interface DimensionDefinition {
  id: string              // derived from displayName via displayNameToId()
  displayName: string
  sourceField?: string    // physical column (absent for derived dims — they use expression)
  descriptionField?: string
  visible?: boolean       // default true
  folderId?: string

  // Deprecated: superseded by TimeDimensionConfig
  isTimeDimension?: boolean
  timeGranularity?: 'second' | 'minute' | 'hour' | 'day' | 'month' | 'quarter' | 'year'
  stockEquality?: 'days' | 'months' | 'quarters' | 'years'

  // For derived dimensions (e.g., quarter from month)
  expression?: string         // SQL expression (used instead of bare column in queries)
  derivedFromField?: string   // physical field this was derived from (for lineage/display)
  sortExpression?: string     // ORDER BY uses MIN(this) instead of the dimension value
}

export interface TimeDimensionConfig {
  sourceColumn: string           // physical column name
  parseExpression?: string       // SQL to convert raw → DATE (absent if already DATE/TIMESTAMP)
  granularity: 'day' | 'month' | 'quarter' | 'year'
  stockWeighting: 'days' | 'months'  // days = day-weighted, months = equal periods
}

export interface MeasureDefinition {
  id: string              // derived from displayName via displayNameToId()
  displayName: string
  description?: string    // short text shown in editor and as tooltip in table header
  sourceField: string     // physical column: "headcount", "revenue"
  expression?: string     // SQL expression (used instead of bare column in queries)
  aggregation?: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'custom'  // default: sum
  timeAggregation?: 'flow' | 'weighted_avg' | 'eop'       // default: flow
  derivedExpression?: string  // post-ROLLUP window/comparison expression; mutually exclusive with expression
  dependsOn?: string[]        // measure IDs this derivedExpression references; auto-included in queries
  formatId?: string
  visible?: boolean       // default true
  folderId?: string
}

export interface HierarchyConfig {
  id: string
  name: string
  levels: string[] // dimension IDs in drill order
  folderId?: string
}

export interface FlowDeclaration {
  dimensionId: string       // qualifier dimension (e.g., "metric_type")
  valueColumn: string       // numeric column it qualifies (e.g., "amount")
  stockValues: string[]     // values that are stocks (weighted avg across time)
  flowValues: string[]      // values that are flows (sum across time)
  excludeValues?: string[]  // values to filter out entirely
  // Unclassified values (not in any list) default to flow (sum)
}

export interface Filter {
  field: string
  operator: '=' | 'in' | 'not_in' | 'between' | 'like'
  value: unknown
}

export interface PivotValue {
  field: string
  aggregation?: 'sum' | 'count' | 'avg' | 'min' | 'max'
}

/**
 * An explicit sort for a query result.
 *
 * `dimension` sorts one dimension level in the chosen direction — the axis is
 * wherever that dimension sits. `measure` reorders the members of one axis by
 * that measure, each level ranked by its own group total, so subtotals keep
 * their place under the members they belong to.
 */
export type ReportSort =
  | { by: 'dimension'; field: string; direction: 'asc' | 'desc' }
  | {
      by: 'measure'
      measure: string
      axis?: 'rows' | 'columns'
      direction: 'asc' | 'desc'
      // Rank by one column's values rather than by the member's whole-row total.
      // Outer-to-inner values of the opposite axis, e.g. ['2024']. Absent or
      // empty means the whole-row total.
      colPath?: string[]
    }

/** Separators used to join path values in rollup result keys. */
export const SEP = '\x1F'
export const CROSS_SEP = '\x1F\x1F'
