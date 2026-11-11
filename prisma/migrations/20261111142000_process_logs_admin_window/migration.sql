-- Central process_logs owner only. Do not run in tenant CRM/runtime databases.
-- Preflight information_schema.STATISTICS; execute only when this index is absent.
-- Additive online index; no log rows are changed or removed.
ALTER TABLE `process_logs`
  ADD INDEX `process_logs_instance_created_at_id_idx` (`instance`, `created_at`, `id`),
  ALGORITHM=INPLACE, LOCK=NONE;
