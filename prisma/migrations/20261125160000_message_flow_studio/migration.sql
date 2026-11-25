CREATE TABLE `message_flow_library` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `steps` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    INDEX `message_flow_library_instance_sector_id_idx` (`instance`, `sector_id`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `message_flow_publications` (
    `instance` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `library_id` INTEGER NOT NULL,
    `revision` INTEGER NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `generation` INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (`instance`, `sector_id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
