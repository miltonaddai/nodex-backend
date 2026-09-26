# Database SQL

SQL is grouped by database so ClickHouse statements cannot be confused with Supabase/PostgreSQL
statements.

```text
sql/
├── clickhouse/
│   ├── schema.sql
│   └── migrations/
│       └── 002-... through 012-...
└── supabase/
    ├── schema.sql
    └── migrations/
        ├── 001-stripe-columns.sql
        └── 002-watchlist-tokens.sql
```

## Setting up or upgrading a database

Run the relevant database's `schema.sql`. Each one is the final schema and is safe on a fresh
database, on an existing one, and on reruns: tables are created only if missing and later columns
are added only if missing.

- ClickHouse: paste `clickhouse/schema.sql` into the ClickHouse Cloud SQL console, or run
  `clickhouse client --multiquery < clickhouse/schema.sql` with your connection flags.
- Supabase: paste `supabase/schema.sql` into Dashboard → SQL Editor → New query and run it.

The numbered migrations are kept as history. One change cannot be expressed as an upgrade
statement: ClickHouse migration 003 rebuilt `token_analytics` to add `period_days` to its sort
key. A database created before 003 still needs that migration run by hand.

When adding a database change:

1. Add the next numbered migration under the correct database.
2. Make the migration safe for the intended existing schema.
3. Apply the same final shape to that database's `schema.sql`, including an add-if-missing
   upgrade statement for any new column.
4. Update any migration runner that needs to execute the new file.
