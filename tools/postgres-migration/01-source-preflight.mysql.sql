-- READ ONLY. Operator chooses a restored snapshot/database before execution.
-- Metadata can disclose internal structure; keep output access restricted.
SELECT DATABASE() AS source_database, VERSION() AS server_version,
       @@session.time_zone AS session_timezone, @@global.time_zone AS global_timezone,
       @@character_set_database AS character_set_database,
       @@collation_database AS collation_database, @@sql_mode AS sql_mode;

SELECT filename, applied_at FROM schema_migrations ORDER BY filename;

SELECT table_name, table_type, engine, table_collation, table_rows
FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name;
-- table_rows above is only an estimate. Generate exact read-only count queries:
SELECT CONCAT('SELECT ', QUOTE(table_name), ' AS table_name, COUNT(*) AS row_count FROM `',
              REPLACE(table_name, '`', '``'), '`;') AS exact_count_sql
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name;

SELECT table_name, ordinal_position, column_name, column_type, is_nullable,
       column_default, extra, character_set_name, collation_name, generation_expression
FROM information_schema.columns WHERE table_schema = DATABASE()
ORDER BY table_name, ordinal_position;

SELECT table_name, index_name, non_unique, seq_in_index, column_name, sub_part, index_type
FROM information_schema.statistics WHERE table_schema = DATABASE()
ORDER BY table_name, index_name, seq_in_index;

SELECT k.table_name, k.constraint_name, k.ordinal_position, k.column_name,
       k.referenced_table_name, k.referenced_column_name, r.update_rule, r.delete_rule
FROM information_schema.key_column_usage k
LEFT JOIN information_schema.referential_constraints r
  ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
 AND r.table_name = k.table_name
WHERE k.table_schema = DATABASE() ORDER BY k.table_name, k.constraint_name, k.ordinal_position;

SELECT trigger_name, event_object_table, event_manipulation, action_timing, action_statement
FROM information_schema.triggers WHERE trigger_schema = DATABASE();
SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = DATABASE();
SELECT routine_name, routine_type, routine_definition
FROM information_schema.routines WHERE routine_schema = DATABASE();
SELECT event_name, status, event_definition FROM information_schema.events WHERE event_schema = DATABASE();
-- Absence may reflect insufficient privileges; have DBA verify completeness.

-- Generate range checks; PostgreSQL bigint cannot represent all BIGINT UNSIGNED values.
SELECT CONCAT('SELECT ', QUOTE(CONCAT(table_name, '.', column_name)),
 ' AS column_name, MIN(`', REPLACE(column_name, '`', '``'), '`), MAX(`',
 REPLACE(column_name, '`', '``'), '`), SUM(`', REPLACE(column_name, '`', '``'),
 '` > 9223372036854775807) AS exceeds_pg_bigint FROM `',
 REPLACE(table_name, '`', '``'), '`;') AS unsigned_range_sql
FROM information_schema.columns WHERE table_schema = DATABASE()
AND data_type = 'bigint' AND column_type LIKE '%unsigned%';

-- Generate zero/partial-zero date checks; decide remediation, never silently discard.
SELECT CONCAT('SELECT ', QUOTE(CONCAT(table_name, '.', column_name)),
 ' AS column_name, COUNT(*) AS invalid_date_rows FROM `', REPLACE(table_name, '`', '``'),
 '` WHERE CAST(`', REPLACE(column_name, '`', '``'),
 '` AS CHAR) REGEXP ''(^0000-|^[0-9]{4}-00-|^[0-9]{4}-[0-9]{2}-00)'';') AS zero_date_sql
FROM information_schema.columns WHERE table_schema = DATABASE()
AND data_type IN ('date', 'datetime', 'timestamp');
