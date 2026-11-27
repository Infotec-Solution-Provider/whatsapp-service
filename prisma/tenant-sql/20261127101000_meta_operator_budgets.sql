CREATE TABLE IF NOT EXISTS `wpp_runtime_meta_operator_budgets` (
	`instance` VARCHAR(191) NOT NULL,
	`month` CHAR(7) NOT NULL,
	`operator_id` INT NOT NULL,
	`budget_cents` INT NOT NULL,
	`updated_by` INT NOT NULL,
	`updated_at` DATETIME NOT NULL,
	PRIMARY KEY (`instance`, `month`, `operator_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
