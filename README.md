# Spreadsheet Coder

This repository holds two things:

- **`engine/`** — the semantic model and SQL engine. Given a semantic model of
  one flat table and a query (measures, group-by dimensions, filters), it
  generates DuckDB SQL. See [`engine/README.md`](engine/README.md).
- **The repository root** — a built copy of the browser pivot app, served at
  https://mathmatthew.github.io/spreadsheet_coder/

MIT licensed; see [`LICENSE`](LICENSE).
