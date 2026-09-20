/** Dedicated database only. Does not run at application startup. */
export const LOGS_DDL = [
	`CREATE TABLE IF NOT EXISTS process_log_store (
		id INT PRIMARY KEY, schema_version INT NOT NULL, state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
		last_cleanup_slot VARCHAR(32) CHARACTER SET ascii NULL
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS process_logs (
		id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
		instance VARCHAR(191) NOT NULL, process_name VARCHAR(191) NOT NULL, process_id VARCHAR(191) NOT NULL,
		status VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
		start_time DATETIME(3) NOT NULL, end_time DATETIME(3) NOT NULL, duration INT NOT NULL,
		input LONGTEXT NULL, output LONGTEXT NULL, error LONGTEXT NULL, error_message TEXT NULL, log_entries LONGTEXT NULL,
		created_at DATETIME(3) NOT NULL,
		INDEX process_logs_instance_process_name_idx (instance, process_name),
		INDEX process_logs_status_created_at_idx (status, created_at),
		INDEX process_logs_instance_status_idx (instance, status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS process_log_copy_state (
		id INT PRIMARY KEY, source_identity VARCHAR(64) CHARACTER SET ascii NOT NULL,
		last_id INT NOT NULL DEFAULT 0, upper_id INT NOT NULL DEFAULT 0,
		rollback_last_id INT NOT NULL DEFAULT 0,
		verified_at DATETIME(3) NULL, copied_rows BIGINT NOT NULL DEFAULT 0
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
] as const;

export const LOG_COLUMNS = ["id", "instance", "process_name", "process_id", "status", "start_time", "end_time", "duration", "input", "output", "error", "error_message", "log_entries", "created_at"] as const;
export const LOG_FIELDS_SQL = LOG_COLUMNS.map(column => `\`${column}\``).join(", ");
