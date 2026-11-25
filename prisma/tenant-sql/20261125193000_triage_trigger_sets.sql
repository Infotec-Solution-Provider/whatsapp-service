CREATE TABLE IF NOT EXISTS wpp_runtime_triage_trigger_sets (
  instance VARCHAR(128) NOT NULL,
  sector_id INT NOT NULL,
  revision INT NOT NULL,
  rules LONGTEXT NOT NULL,
  edited_by INT NOT NULL,
  edited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (instance, sector_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
