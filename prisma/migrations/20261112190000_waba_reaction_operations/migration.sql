-- Durable correlation of reaction sends and their asynchronous WABA receipts.
-- No message/queue rows are created or rewritten by this additive migration.
CREATE TABLE IF NOT EXISTS `waba_reaction_operations` (
  `id` CHAR(36) NOT NULL,
  `sequence` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `instance` VARCHAR(191) NOT NULL,
  `client_id` INTEGER NOT NULL,
  `target_message_id` VARCHAR(191) NOT NULL,
  `recipient_id` VARCHAR(32) NOT NULL,
  `emoji` VARCHAR(64) NOT NULL,
  `provider_message_id` VARCHAR(191) NULL,
  `status` VARCHAR(16) NOT NULL,
  `status_at` DATETIME(3) NULL,
  `error_code` VARCHAR(64) NULL,
  `baseline_reaction_json` LONGTEXT NULL,
  `internal_user_id` INTEGER NULL,
  `internal_user_name` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `accepted_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `waba_reaction_operation_sequence` (`sequence`),
  UNIQUE KEY `waba_reaction_operation_scope_provider` (`instance`,`client_id`,`provider_message_id`),
  KEY `waba_reaction_operation_target` (`instance`,`client_id`,`target_message_id`,`created_at`),
  CONSTRAINT `waba_reaction_operation_status` CHECK (`status` IN ('PREPARED','ACCEPTED','UNKNOWN','REJECTED','SENT','DELIVERED','READ','FAILED')),
  CONSTRAINT `waba_reaction_operation_baseline_json` CHECK (`baseline_reaction_json` IS NULL OR JSON_VALID(`baseline_reaction_json`))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
