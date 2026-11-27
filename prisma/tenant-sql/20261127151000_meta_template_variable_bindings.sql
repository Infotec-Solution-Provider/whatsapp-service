CREATE TABLE IF NOT EXISTS `wpp_runtime_meta_template_variable_bindings` (
	`instance` VARCHAR(191) NOT NULL,
	`account_id` VARCHAR(32) NOT NULL,
	`template_id` VARCHAR(32) NOT NULL,
	`body_hash` CHAR(64) NOT NULL,
	`variable_sources` JSON NOT NULL,
	PRIMARY KEY (`instance`, `account_id`, `template_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
