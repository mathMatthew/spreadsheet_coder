# Semantic SQL engine

Semantic model + flat table + query → DuckDB SQL.

The model describes one flat table: which columns are dimensions, which are
measures, and how each measure aggregates. A query names the measures you want,
the dimensions to group by, and the filters. The engine returns SQL plus a
description of the result columns. It does not run the SQL; run it with any
DuckDB client against a table or view named `data` (or pass `source`).

No UI, no runtime dependencies.

## Example

```ts
import { QueryBuilder, type QuerySchema } from './src/index'

const model: QuerySchema = {
  dimensions: [
    { id: 'region', displayName: 'Region', sourceField: 'region' },
    { id: 'year', displayName: 'Year', sourceField: 'year' },
  ],
  measures: [
    { id: 'revenue', displayName: 'Revenue', sourceField: 'revenue', aggregation: 'sum' },
  ],
  hierarchies: [],
}

const q = new QueryBuilder(model).buildRollupAggregation({
  rowDimensions: ['region', 'year'],
  measures: ['revenue'],
  filters: [{ field: 'year', operator: 'in', value: [2024, 2025] }],
})
```

`q.sql` is:

```sql
SELECT GROUPING("region") AS "_g_region", GROUPING("year") AS "_g_year", "region", "year", CAST(SUM("revenue") AS DOUBLE) AS "revenue"
FROM "data"
WHERE "year" IN (2024, 2025)
GROUP BY ROLLUP("region", "year")
ORDER BY GROUPING("region"), "region", GROUPING("year"), "year"
```

The result has detail rows, a subtotal per region, and a grand total. Each
`_g_<dimension>` column is 1 on rows where that dimension is rolled up. The
rest of `q` lists those grouping columns, the dimension and measure columns, and
how many leading dimensions are row dimensions.

## What the model covers

All in [`src/model.ts`](src/model.ts):

- **Dimensions** — a physical column, or a SQL expression (for example a
  quarter derived from a month), with optional display and sort columns.
- **Measures** — `sum`, `avg`, `count`, `min`, `max`, or a custom SQL
  expression. Across time a measure is a `flow` (summed), a `weighted_avg`
  balance, or an `eop` (end-of-period) balance, so totals over time come out
  right for balances.
- **Comparison measures** (`derivedExpression`) — window expressions computed
  after the rollup, such as change from the prior year.
- **Time dimensions** and **hierarchies** (dimension drill order).
- **Flow declarations** — for long-format tables where one column says whether
  the value column on that row is a stock or a flow.

## Query entry points

- `buildRollupAggregation` — detail rows, subtotals and grand total, with
  row and column dimensions, percent of row/column/total, top-N limits that keep
  true totals, and explicit sorts that keep subtotals in place.
- `buildAggregation` — a flat GROUP BY with no totals. It does not compute
  comparison measures (they come back NULL) or the special balance handling, so
  use the rollup path for those.

[`src/summary-views.ts`](src/summary-views.ts) builds pre-aggregated summary
tables and, for a query, picks the one with the fewest dimensions that can
answer it.

## Tests

```bash
npm install
npm test        # 298 tests; each runs the generated SQL in an in-memory DuckDB
npm run typecheck
```

## Origin

Extracted from a private analysis app where it has been the query layer. This
copy is the engine only.
