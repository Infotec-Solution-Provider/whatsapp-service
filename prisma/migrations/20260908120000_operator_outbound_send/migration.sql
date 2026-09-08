-- Add an explicit uncertain outcome; no automatic resend is safe in this state.
ALTER TABLE `messages` MODIFY `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED', 'UNKNOWN') NOT NULL;
ALTER TABLE `internalmessages` MODIFY `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED', 'UNKNOWN') NOT NULL;

-- Retain scope/key records indefinitely. Any future archival must keep a unique
-- tombstone; deleting completed jobs would allow old requests to send again.
CREATE TABLE `operator_outbound_send` (
  `id` VARCHAR(191) NOT NULL,
  `instance` VARCHAR(191) NOT NULL,
  `user_id` INTEGER NOT NULL,
  `client_id` INTEGER NOT NULL,
  `idempotency_key` VARCHAR(191) NOT NULL,
  `payload_hash` CHAR(64) NOT NULL,
  `payload` JSON NOT NULL,
  `message_id` INTEGER NOT NULL,
  `delivery_mode` ENUM('REMOTE', 'DIRECT') NOT NULL,
  `status` ENUM('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
  `remote_job_id` VARCHAR(191) NULL,
  `provider_outcome` JSON NULL,
  `notification_pending` BOOLEAN NOT NULL DEFAULT false,
  `attempt_started_at` DATETIME(3) NULL,
  `attempt_count` INTEGER NOT NULL DEFAULT 0,
  `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `locked_by` VARCHAR(191) NULL,
  `locked_until` DATETIME(3) NULL,
  `error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) NULL,
  UNIQUE INDEX `operator_outbound_scope_key` (`instance`, `user_id`, `idempotency_key`),
  UNIQUE INDEX `operator_outbound_send_message_id_key` (`message_id`),
  INDEX `operator_outbound_send_status_next_attempt_at_idx` (`status`, `next_attempt_at`),
  INDEX `operator_outbound_send_status_locked_until_idx` (`status`, `locked_until`),
  INDEX `operator_outbound_send_notification_pending_next_attempt_at_idx` (`notification_pending`, `next_attempt_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `operator_outbound_send_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `messages` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
