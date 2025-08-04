-- AlterTable
ALTER TABLE `clients` ADD COLUMN `gupshup_app_id` VARCHAR(191) NULL,
    ADD COLUMN `gupshup_app_name` VARCHAR(191) NULL,
    ADD COLUMN `gupshup_token` VARCHAR(191) NULL;
