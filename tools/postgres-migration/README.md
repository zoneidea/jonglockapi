# PostgreSQL migration preparation — NOT a production migration

Status: preparation only. No database connection, export, schema change, dependency
installation, or API driver change was performed. These files are outside the
existing `migrations/` directory and are NOT executed by `npm run migrate`.

## Files

- `inventory.cjs`: offline inventory of every repository migration (SHA-256),
  table declarations, and MySQL-specific source locations. Prints JSON only;
  does not load `.env`, connect to a database, or write files.
- `01-source-preflight.mysql.sql`: read-only source metadata queries, including
  generated exact-count and unsigned-range queries for an operator to review.
- `02-transfer.load.template`: full-database pgloader rehearsal template;
  placeholder hosts are deliberately invalid. Creates schema/indexes/FKs from
  actual source metadata, copies all tables, and resets sequences.
- `03-target-verify.psql`: read-only PostgreSQL verification and exact table
  counts. Requires psql and an explicitly chosen target schema.
- `04-acceptance-and-rollback.md`: approval gates, mapping decisions, validation,
  cutover, and rollback checklist.
- `.gitignore`: prevent committing populated connection files, dumps, and logs.

## Scope and completeness

The intended transfer includes ALL base tables in the selected source database,
including master data, organization/market/booth data, encrypted user fields,
bookings/payments/refunds, subscriptions, audit/logs, support, layouts,
`markets.deleted_at`, and `schema_migrations`. No table exclusion is configured.
Views, triggers, routines, scheduled events, grants, and files referenced by URL
need a separate reviewed plan after source preflight. They are not assumed to be
converted by the table loader. `uploads/`, object storage, encryption keys, and
Firebase data are not relational database tables and need separate backups.

Repository SQL is not proof of the live schema: migrations include conditional
and dynamic SQL and data repairs. Do not concatenate or regex-convert it into a
supposed final PostgreSQL schema. Snapshot live metadata later using a read-only
account or restored backup. Compare **filenames**, not numeric prefixes, against
`schema_migrations` (032 and 044 have multiple files). Reconcile missing/extra
migrations, especially 050, before accepting a baseline. Never rerun existing
MySQL migrations against PostgreSQL.

## Safe preparation now

Run only the offline inventory:

```sh
node tools/postgres-migration/inventory.cjs
```

Review output in a restricted location if saved. Regenerate after any new MySQL
migration; this package does not freeze future schema changes.

## Later, after explicit approval (DO NOT run now)

1. Choose PostgreSQL version/provider, source snapshot and schema name, maintenance
   window, TLS connectivity and restricted credentials. Pin/test the pgloader
   version and its MySQL authentication/TLS support. Do not weaken production TLS
   to make a loader work; prefer a restored isolated MySQL copy.
2. Take an encrypted consistent MySQL backup including metadata, routines/triggers/
   events and test restoring it. Keep keys separately. Run source preflight on
   the restored copy; reconcile its migrations with inventory.
3. Provision a NEW EMPTY PostgreSQL rehearsal database, never an existing shared
   database. Copy the load template to an ignored `*.local.load`, populate URLs
   with percent-encoded credentials using secure tooling, restrict file access.
   The `.template` is not an environment-substitution mechanism.
4. Resolve all mapping decisions in the acceptance checklist before loading.
   Review pgloader casts for actual data, especially booleans, unsigned IDs,
   ENUM, dates and collation. Rehearse transfer only after approval.
5. Run target verification in psql, compare exact counts and reconciliation
   checks against the SAME immutable source snapshot. Any rejected row, missing
   table/constraint, or aggregate mismatch is a blocker, not a tolerated warning.
6. After acceptance, export a schema-only PostgreSQL baseline using `pg_dump
   --schema-only --no-owner --no-privileges` with connection configured securely.
   Review that baseline; create a separate PostgreSQL migration ledger for future
   changes. The imported MySQL ledger is historical evidence only.
7. Port/test the API in a separately approved task, then rehearse final cutover.
   Changing DB_HOST or installing `pg` alone is NOT sufficient.

No automatic deployment hook, startup initializer, or npm migration command is
added intentionally. Committing this folder must not start a transfer.

## References

- https://pgloader.readthedocs.io/en/latest/ref/mysql.html
- https://www.postgresql.org/docs/current/app-pg-dump.html
- https://www.postgresql.org/docs/current/datatype.html

The template explicitly disables drop/truncate rather than relying on loader
defaults. Nonetheless a transfer writes its target and must only use a newly
provisioned rehearsal database. Do not rerun against a partially populated target.
