ALTER TABLE `internal_message_processing_queue`
  MODIFY `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING';

CREATE UNIQUE INDEX `internal_message_processing_queue_internal_message_id_key`
  ON `internal_message_processing_queue`(`internal_message_id`);
