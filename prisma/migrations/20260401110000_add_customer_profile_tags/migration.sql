CREATE TABLE `customer_profile_tags` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `customer_id` INT NOT NULL,
    `tag_type` ENUM('INTERACTION_LEVEL', 'PURCHASE_LEVEL', 'CUSTOMER_AGE') NOT NULL,
    `tag_value` VARCHAR(64) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `color` VARCHAR(32) NOT NULL,
    `calculated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `metadata_json` JSON NULL,

    UNIQUE INDEX `customer_profile_tags_instance_customer_id_tag_type_key`(`instance`, `customer_id`, `tag_type`),
    INDEX `customer_profile_tags_instance_customer_id_idx`(`instance`, `customer_id`),
    INDEX `customer_profile_tags_instance_tag_type_tag_value_idx`(`instance`, `tag_type`, `tag_value`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;