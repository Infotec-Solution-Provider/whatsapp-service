CREATE TABLE `frontend_performance_sessions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `instance` VARCHAR(191) NOT NULL,
  `user_id` INTEGER NOT NULL,
  `session_id` VARCHAR(36) NOT NULL,
  `build_id` VARCHAR(64) NOT NULL,
  `device_class` VARCHAR(16) NOT NULL,
  `browser` VARCHAR(64) NOT NULL,
  `hardware_concurrency` INTEGER NULL,
  `device_memory_gb` DOUBLE NULL,
  `effective_type` VARCHAR(16) NULL,
  `viewport_width` INTEGER NOT NULL,
  `viewport_height` INTEGER NOT NULL,
  `started_at` DATETIME(3) NOT NULL,
  `last_seen_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `fps_instance_user_session_key` (`instance`, `user_id`, `session_id`),
  INDEX `fps_instance_started_idx` (`instance`, `started_at`),
  INDEX `fps_instance_device_started_idx` (`instance`, `device_class`, `started_at`),
  INDEX `fps_build_started_idx` (`build_id`, `started_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `frontend_performance_samples` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `session_id` INTEGER NOT NULL,
  `instance` VARCHAR(191) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `value` DOUBLE NOT NULL,
  `unit` VARCHAR(16) NOT NULL,
  `route` VARCHAR(255) NOT NULL,
  `tags` JSON NULL,
  `occurred_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `fpm_instance_occurred_idx` (`instance`, `occurred_at`),
  INDEX `fpm_instance_name_occurred_idx` (`instance`, `name`, `occurred_at`),
  INDEX `fpm_session_occurred_idx` (`session_id`, `occurred_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `fpm_session_fkey`
    FOREIGN KEY (`session_id`) REFERENCES `frontend_performance_sessions` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
