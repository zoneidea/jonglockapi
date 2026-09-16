# Migration gates — every unchecked item blocks production cutover

## Decisions before rehearsal

- [ ] Pin PostgreSQL/provider and pgloader versions; test authentication and TLS.
- [ ] Verify backup restore, source server version, actual tables/schema drift,
  migration filenames and all views/triggers/routines/events/permissions.
- [ ] Define a consistent snapshot: use a restored backup for rehearsal. For final
  transfer freeze ALL writers, jobs, admin tools and callbacks, or design approved
  CDC. Parallel table loading is not a cross-table snapshot of a changing source.
- [ ] BIGINT UNSIGNED: check real maxima; use signed bigint only when safe, otherwise
  choose numeric mapping consistently across parent and foreign-key columns.
  Keep JS bigint/decimal serialization lossless; never silently cast to Number.
- [ ] Preserve exact DECIMAL precision/scale and money totals; never use floats.
- [ ] Approve ENUM mapping and all values after ALTER migrations. Do not lose status
  restrictions by converting to unconstrained text. Preserve boolean/numeric API
  semantics for tinyint; do not assume every tinyint is a boolean.
- [ ] Decide timezone per column: MySQL TIMESTAMP vs DATETIME, source session zone,
  current mysql2 `+07:00`, and date-only booking days. Avoid a silent seven-hour
  shift. Test Thai midnight boundaries. Decide how zero dates are handled.
- [ ] Preserve MySQL case/accent-insensitive uniqueness/search semantics explicitly;
  PostgreSQL default comparisons differ. Test market codes, usernames, Thai search,
  nullable unique keys and prefix indexes before approving collation/index design.
- [ ] Review JSON/JSONB, binary fields, defaults, generated columns and FK actions.
- [ ] Recreate `ON UPDATE CURRENT_TIMESTAMP` behavior via reviewed PostgreSQL
  triggers or explicit application writes. Loader success does not prove this.
- [ ] Keep encrypted `*_enc`, blind indexes and password hashes byte-for-byte;
  retain encryption/index keys separately in a secret manager. No PII in reports.
- [ ] Least privilege: separate migration owner/runtime role, organization scope,
  grants, network access and encrypted backups. Do not grant app superuser access.

## Reconciliation (source and target, same snapshot)

- [ ] Exact table set and row counts, including logs and migration ledger.
- [ ] PK/FK relationships, unique/check constraints, defaults, indexes and sequences.
  Explicitly test orphan references; verify constraints are present AND validated.
- [ ] For each organization/market compare booking/item/payment counts grouped by
  status and exact decimal totals, VAT, refunds and subscription invoice balances.
- [ ] Compare representative ordered records by PK and canonical checksums for all
  data batches. Normalize type formatting only by an approved mapping. Row counts
  alone are NOT sufficient; JSON key order/timezone formatting can differ.
- [ ] All loader logs reviewed, zero rejected/skipped rows, target schema name verified.
- [ ] Sequence next values cannot collide with existing IDs; test insert in isolation.
- [ ] `markets.deleted_at`, layout JSON/grid/booth IDs, date locks, master location
  rows, tenant encryption and historical cancelled/refunded bookings preserved.
- [ ] Upload URLs resolve; file/object-storage backup tested separately.
- [ ] Schema-only target baseline exported and reviewed after successful rehearsal.

## API conversion (separate task; NOT implemented by this package)

- [ ] Replace mysql2 connection/transaction interface and named placeholders safely;
  migrate `insertId`, `affectedRows`, row tuple conventions and generated IDs to
  PostgreSQL equivalents. Parameterize SQL, retain auth/organization scope.
- [ ] Review every MySQL-specific query (inventory reports candidate locations):
  `ON DUPLICATE KEY`, `INSERT IGNORE`, date/JSON functions, GROUP_CONCAT, IF/IFNULL,
  boolean comparisons, backticks, LIMIT placeholders and multi-statement migrations.
- [ ] Test locking/order/isolation, deadlock retries, row-lock rechecks and concurrent
  booking/payment/delete flows. PostgreSQL locking behavior is not interchangeable.
- [ ] Test auth, booking/payment callbacks and idempotency, availability/draft rules,
  audit, import/export, subscriptions, reports, support and all consumers.
- [ ] Benchmark realistic Thai datasets and pool sizing; use EXPLAIN in staging,
  verify tenant-filter/FK/availability indexes. Do not add broad indexes blindly.
- [ ] PostgreSQL migration runner and startup/deployment wiring approved separately;
  existing `npm run migrate` is MySQL-only and must not run on the new target.

## Cutover / rollback (future approval required)

1. Record source/target backup IDs, API commit, schema checksums, keys/config versions,
   owners, maintenance window, measured recovery time and acceptance evidence.
2. Freeze writers; preserve incoming payment callbacks in an approved durable queue
   or verified provider retry process. Do not drop events during maintenance.
3. Final consistent copy to a fresh target, full validation, smoke/concurrency tests,
   then explicitly authorize switching the tested PostgreSQL-compatible API.
4. Keep MySQL snapshot intact/read-only and PostgreSQL backups retained. Monitor
   errors, locks, money reconciliation and callback processing before reopening.
5. BEFORE any target write: rollback can switch API/config back to unchanged MySQL.
6. AFTER any target write: stop writers again and reconcile/replay PostgreSQL-only
   changes (bookings, payments, callbacks, audit events) into the rollback source
   using a separately reviewed plan. Simply changing DB_HOST back loses data.
7. Never dual-write or destroy the old database without separate explicit approval.
