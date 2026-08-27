ALTER TABLE `frontend_performance_sessions`
  ADD INDEX `fps_last_seen_idx` (`last_seen_at`);

ALTER TABLE `frontend_performance_samples`
  ADD COLUMN `batch_id` VARCHAR(64) NULL,
  ADD COLUMN `sample_index` INTEGER NULL,
  ADD INDEX `fpm_occurred_idx` (`occurred_at`);

-- Samples written by the first telemetry version predate the strict route and
-- tag allowlists and can contain free-form path segments or diagnostic text.
-- Preserve their numeric baseline while removing every free-form value and
-- assigning a deterministic legacy batch identity. Run this migration with
-- the feature flag disabled so an older process cannot insert another legacy
-- row concurrently.
UPDATE `frontend_performance_samples`
SET
  `route` = '/legacy-redacted',
  `tags` = NULL,
  `batch_id` = CONCAT('legacy-', LPAD(LOWER(HEX(`id`)), 56, '0')),
  `sample_index` = 0
WHERE `batch_id` IS NULL OR `sample_index` IS NULL;

-- Browser, build and connection values were also formerly bounded strings
-- rather than strict enums. Keep only values accepted by the hardened parser.
UPDATE `frontend_performance_sessions` AS fps
SET
  fps.`browser` = CASE
    WHEN fps.`browser` REGEXP '^(Chrome|Edg|Firefox|Safari) [0-9]{1,4}$' THEN fps.`browser`
    ELSE 'Unknown'
  END,
  fps.`build_id` = CASE
    WHEN LOWER(fps.`build_id`) REGEXP '^(development|performance|stable|temp-stable-with-pannel)$|^[0-9a-f]{7,64}$' THEN LOWER(fps.`build_id`)
    ELSE 'development'
  END,
  fps.`effective_type` = CASE
    WHEN fps.`effective_type` IN ('slow-2g', '2g', '3g', '4g') THEN fps.`effective_type`
    ELSE NULL
  END
WHERE EXISTS (
  SELECT 1
  FROM `frontend_performance_samples` AS sample
  WHERE sample.`session_id` = fps.`id`
    AND sample.`batch_id` LIKE 'legacy-%'
);

ALTER TABLE `frontend_performance_samples`
  MODIFY COLUMN `batch_id` VARCHAR(64) NOT NULL,
  MODIFY COLUMN `sample_index` INTEGER NOT NULL,
  ADD UNIQUE INDEX `fpm_session_batch_sample_key` (`session_id`, `batch_id`, `sample_index`);

CREATE TABLE `frontend_performance_batch_receipts` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `session_db_id` INTEGER NOT NULL,
  `batch_id` VARCHAR(64) NOT NULL,
  `checksum` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `fpbr_session_batch_key` (`session_db_id`, `batch_id`),
  INDEX `fpbr_created_idx` (`created_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `fpbr_session_fkey`
    FOREIGN KEY (`session_db_id`) REFERENCES `frontend_performance_sessions` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
