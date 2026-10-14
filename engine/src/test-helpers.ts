/**
 * Shared test utilities for DuckDB-based tests.
 *
 * Used by query-builder.test.ts, query-builder-pct.test.ts, and summary-views-sql.test.ts.
 */
import type { QuerySchema } from './query-builder'
import type { DimensionDefinition, MeasureDefinition, TimeDimensionConfig, FlowDeclaration } from './model'

// ── Schema factory ───────────────────────────────────────────────────

export function makeSchema(overrides: {
  dimensions?: Partial<DimensionDefinition>[]
  measures?: Partial<MeasureDefinition>[]
  timeDimensions?: TimeDimensionConfig[]
  flowDeclarations?: FlowDeclaration[]
}): QuerySchema {
  const dimensions = (overrides.dimensions ?? []).map((d, i) => ({
    id: d.id ?? `dim_${i}`,
    displayName: d.displayName ?? d.id ?? `Dim ${i}`,
    sourceField: d.sourceField ?? d.id ?? `dim_${i}`,
    ...d
  } as DimensionDefinition))

  const measures = (overrides.measures ?? []).map((m, i) => ({
    id: m.id ?? `measure_${i}`,
    displayName: m.displayName ?? m.id ?? `Measure ${i}`,
    sourceField: m.sourceField ?? m.id ?? `measure_${i}`,
    ...m
  } as MeasureDefinition))

  return {
    dimensions, measures, hierarchies: [],
    timeDimensions: overrides.timeDimensions ?? [],
    flowDeclarations: overrides.flowDeclarations,
  }
}

// ── DuckDB Node driver helpers ───────────────────────────────────────

/** DuckDB Node driver can't serialize BigInt from GROUPING(). Cast to INTEGER for tests. */
export function fixGroupingBigInt(sql: string): string {
  return sql.replace(/GROUPING\(([^)]+)\) AS/g, 'CAST(GROUPING($1) AS INTEGER) AS')
}

/**
 * Run a query and return all rows. Applies fixGroupingBigInt automatically
 * (no-op when the SQL doesn't contain GROUPING()).
 */
export function queryAll(conn: any, sql: string): Promise<Record<string, any>[]> {
  const fixed = fixGroupingBigInt(sql)
  return new Promise((resolve, reject) => {
    conn.all(fixed, (err: Error | null, rows: Record<string, any>[]) => {
      if (err) reject(new Error(`SQL error: ${err.message}\n\nSQL:\n${sql}`))
      else resolve(rows)
    })
  })
}

export function exec(conn: any, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.exec(sql, (err: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

// ── Value normalization ──────────────────────────────────────────────

/** Normalize a DuckDB value for comparison: Date -> ISO date string, BigInt -> Number. */
export function normalize(val: any): any {
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  if (typeof val === 'bigint') return Number(val)
  return val
}

/** Normalize all values in a row object. */
export function normalizeRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = normalize(v)
  }
  return out
}

/** Sort rows by all columns for deterministic comparison. */
export function sortRows(rows: Record<string, any>[]): Record<string, any>[] {
  if (rows.length === 0) return rows
  const keys = Object.keys(rows[0])
  return [...rows].map(normalizeRow).sort((a, b) => {
    for (const k of keys) {
      const av = a[k], bv = b[k]
      if (av == null && bv == null) continue
      if (av == null) return -1
      if (bv == null) return 1
      if (av < bv) return -1
      if (av > bv) return 1
    }
    return 0
  })
}

// ── Row lookup helpers ───────────────────────────────────────────────

/**
 * Find a row by dimension values. Use null for rolled-up dimensions.
 * Checks GROUPING columns to distinguish detail rows from subtotals.
 * Handles DuckDB Date objects and BigInt values via normalize().
 */
export function findRow(rows: Record<string, any>[], dims: Record<string, string | number | null>): Record<string, any> {
  const match = rows.find(row => {
    // Skip true total rows (_tt > 0) -- they are for <Other> calculations, not ROLLUP rows
    if (row._tt != null && Number(row._tt) > 0) return false
    return Object.entries(dims).every(([dimName, value]) => {
      const gCol = `_g_${dimName}`
      if (value === null) return Number(row[gCol]) === 1
      return Number(row[gCol]) === 0 && normalize(row[dimName]) == value  // == handles type coercion
    })
  })
  if (!match) {
    const desc = Object.entries(dims).map(([k, v]) => `${k}=${v}`).join(', ')
    throw new Error(`No row found matching: ${desc}`)
  }
  return match
}

/** Filter rows to only include ROLLUP rows (exclude true total rows with _tt > 0). */
export function rollupRows(rows: Record<string, any>[]): Record<string, any>[] {
  return rows.filter(row => row._tt == null || Number(row._tt) === 0)
}
