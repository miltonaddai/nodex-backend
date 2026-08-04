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

## Fresh databases

Run only the relevant database's `schema.sql`. Each schema is a current baseline containing all
changes represented by its migrations.

## Existing databases

Do not rerun the baseline. Apply only migrations that the database has not already received, in
ascending numeric order. The ClickHouse migration history starts at 002 because the original
schema was the historical 001 baseline.

When adding a database change:

1. Add the next numbered migration under the correct database.
2. Make the migration safe for the intended existing schema.
3. Apply the same final shape to that database's `schema.sql` for fresh installs.
4. Update any migration runner that needs to execute the new file.
