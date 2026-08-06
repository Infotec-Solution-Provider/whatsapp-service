CREATE TABLE `internal_whatsapp_senders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `sender_id` VARCHAR(191) NOT NULL,
    `display_name` VARCHAR(191) NULL,
    `is_manually_named` BOOLEAN NOT NULL DEFAULT false,
    `assigned_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `internal_whatsapp_senders_instance_sender_id_key`(`instance`, `sender_id`),
    INDEX `internal_whatsapp_senders_instance_display_name_idx`(`instance`, `display_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `internalmessages`
    ADD COLUMN `whatsapp_sender_id` INTEGER NULL;

INSERT INTO `internal_whatsapp_senders` (
    `instance`,
    `sender_id`,
    `display_name`, 
    `is_manually_named`,
    `created_at`,
    `updated_at`
)
SELECT
    parsed.`instance`,
    parsed.`sender_id`,
    MAX(
        CASE
            WHEN parsed.`candidate_name` IS NULL THEN NULL
            WHEN TRIM(parsed.`candidate_name`) = '' THEN NULL
            WHEN TRIM(parsed.`candidate_name`) = parsed.`sender_id` THEN NULL
            WHEN TRIM(parsed.`candidate_name`) REGEXP '^[+() .-]*[0-9][0-9+() .-]*$' THEN NULL
            WHEN TRIM(parsed.`candidate_name`) REGEXP '@(c\\.us|g\\.us|lid|s\\.whatsapp\\.net)$' THEN NULL
            ELSE TRIM(parsed.`candidate_name`)
        END
    ) AS `display_name`,
    false,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM (
    SELECT
        `instance`,
        SUBSTRING_INDEX(SUBSTRING(`from`, 10), ':', 1) AS `sender_id`,
        CASE
            WHEN LOCATE(':', SUBSTRING(`from`, 10)) > 0
                THEN SUBSTRING(SUBSTRING(`from`, 10), LOCATE(':', SUBSTRING(`from`, 10)) + 1)
            ELSE NULL
        END AS `candidate_name`
    FROM `internalmessages`
    WHERE `from` LIKE 'external:%'
) AS parsed
WHERE parsed.`sender_id` <> ''
GROUP BY parsed.`instance`, parsed.`sender_id`;

UPDATE `internalmessages` AS message
INNER JOIN `internal_whatsapp_senders` AS sender
    ON sender.`instance` = message.`instance`
    AND sender.`sender_id` = SUBSTRING_INDEX(SUBSTRING(message.`from`, 10), ':', 1)
SET message.`whatsapp_sender_id` = sender.`id`
WHERE message.`from` LIKE 'external:%';

CREATE INDEX `internalmessages_whatsapp_sender_id_id_idx`
    ON `internalmessages`(`whatsapp_sender_id`, `id`);

ALTER TABLE `internalmessages`
    ADD CONSTRAINT `internalmessages_whatsapp_sender_id_fkey`
    FOREIGN KEY (`whatsapp_sender_id`) REFERENCES `internal_whatsapp_senders`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
