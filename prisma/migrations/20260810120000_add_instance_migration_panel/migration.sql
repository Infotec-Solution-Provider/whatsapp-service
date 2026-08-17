CREATE TABLE `instance_migration_runs` (
    `id` VARCHAR(36) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `current_phase` VARCHAR(32) NOT NULL,
    `config_json` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `instance_migration_runs_instance_status_idx`(`instance`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `instance_migration_maps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `run_id` VARCHAR(36) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `entity` VARCHAR(64) NOT NULL,
    `source_id` VARCHAR(128) NOT NULL,
    `target_id` INTEGER NULL,
    `source_fingerprint` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `instance_migration_maps_run_id_entity_idx`(`run_id`, `entity`),
    UNIQUE INDEX `instance_migration_maps_instance_entity_source_id_key`(`instance`, `entity`, `source_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `instance_migration_maps`
    ADD CONSTRAINT `instance_migration_maps_run_id_fkey`
    FOREIGN KEY (`run_id`) REFERENCES `instance_migration_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
