-- CreateTable
CREATE TABLE `ciag_integrations` (
    `id` VARCHAR(100) NOT NULL,
    `key_hash` CHAR(64) NOT NULL,
    `instance` VARCHAR(100) NOT NULL,
    `client_id` INTEGER NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ciag_integrations_key_hash_key`(`key_hash`),
    INDEX `ciag_integrations_instance_client_id_idx`(`instance`, `client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ciag_outbound` (
    `id` CHAR(36) NOT NULL,
    `integration_id` VARCHAR(100) NOT NULL,
    `external_id` VARCHAR(160) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `data` JSON NOT NULL,
    `state` VARCHAR(20) NOT NULL DEFAULT 'queued',
    `message_id` INTEGER NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lease_until` DATETIME(3) NULL,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ciag_outbound_state_next_at_idx`(`state`, `next_at`),
    UNIQUE INDEX `ciag_outbound_integration_id_external_id_key`(`integration_id`, `external_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ciag_contact_state` (
    `integration_id` VARCHAR(100) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `consent` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `evidence` TEXT NULL,
    `read_at` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`integration_id`, `phone`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ciag_media` (
    `integration_id` VARCHAR(100) NOT NULL,
    `file_id` INTEGER NOT NULL,
    `voice` BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY (`integration_id`, `file_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ciag_audit` (
    `id` CHAR(36) NOT NULL,
    `integration_id` VARCHAR(100) NOT NULL,
    `actor_id` VARCHAR(100) NOT NULL,
    `actor_name` VARCHAR(200) NOT NULL,
    `action` VARCHAR(100) NOT NULL,
    `data` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ciag_audit_integration_id_created_at_idx`(`integration_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ciag_contact_locks` (
    `integration_id` VARCHAR(100) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `owner` CHAR(36) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`integration_id`, `phone`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
