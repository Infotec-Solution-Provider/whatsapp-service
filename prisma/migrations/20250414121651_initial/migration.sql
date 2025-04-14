-- CreateTable
CREATE TABLE `instances` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `instance_name` VARCHAR(191) NOT NULL,
    `type` ENUM('WABA', 'WWEBJS') NOT NULL,
    `is_active` BOOLEAN NOT NULL,
    `WABA_phone_id` VARCHAR(191) NULL,
    `WABA_token` VARCHAR(191) NULL,

    INDEX `instances_is_active_idx`(`is_active`),
    UNIQUE INDEX `instances_instance_name_name_key`(`instance_name`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `customer_id` INTEGER NULL,
    `instance_name` VARCHAR(191) NOT NULL,
    `is_blocked` BOOLEAN NOT NULL DEFAULT false,
    `only_admin` BOOLEAN NOT NULL DEFAULT false,

    INDEX `contacts_customer_id_instance_name_idx`(`customer_id`, `instance_name`),
    UNIQUE INDEX `contacts_instance_name_phone_key`(`instance_name`, `phone`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `messages` (
    `instance_name` VARCHAR(191) NOT NULL,
    `id` VARCHAR(191) NOT NULL,
    `from` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quoted_id` VARCHAR(191) NULL,
    `chat_id` INTEGER NULL,
    `body` VARCHAR(191) NOT NULL,
    `timestamp` BIGINT NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR') NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `file_type` VARCHAR(191) NULL,
    `file_size` BIGINT NULL,

    INDEX `messages_from_to_chat_id_idx`(`from`, `to`, `chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance_name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `is_finished` BOOLEAN NOT NULL DEFAULT false,
    `user_id` INTEGER NULL,
    `wallet_id` INTEGER NULL,
    `bot_id` INTEGER NULL,
    `result_id` INTEGER NULL,
    `sector_id` INTEGER NOT NULL,
    `type` ENUM('RECEPTIVE', 'ACTIVE') NOT NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'URGENCY') NOT NULL DEFAULT 'NORMAL',
    `avatar_url` VARCHAR(191) NULL,

    INDEX `chats_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sectors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `instance_name` VARCHAR(191) NOT NULL,
    `wpp_instance_id` INTEGER NULL,
    `start_chats` BOOLEAN NOT NULL,
    `receive_chats` BOOLEAN NOT NULL,

    UNIQUE INDEX `sectors_instance_name_name_key`(`instance_name`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sectors_users` (
    `instance_name` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `sector_id` INTEGER NOT NULL,

    UNIQUE INDEX `sectors_users_instance_name_user_id_key`(`instance_name`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flows` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance_name` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `description` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `message_flows_instance_name_sector_id_key`(`instance_name`, `sector_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flows_steps` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `type` ENUM('CHECK_AVAILABLE_USERS', 'CHECK_LOALTY', 'CHECK_ONLY_ADMIN', 'SEND_TO_ADMIN') NOT NULL,
    `message_flow_id` INTEGER NOT NULL,
    `step_number` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `message_flows_steps_message_flow_id_step_number_key`(`message_flow_id`, `step_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets` (
    `instance_name` VARCHAR(191) NOT NULL,
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets_users` (
    `wallet_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    UNIQUE INDEX `wallets_users_wallet_id_user_id_key`(`wallet_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_instance_name_phone_fkey` FOREIGN KEY (`instance_name`, `phone`) REFERENCES `contacts`(`instance_name`, `phone`) ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_wpp_instance_id_fkey` FOREIGN KEY (`wpp_instance_id`) REFERENCES `instances`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sectors_users` ADD CONSTRAINT `sectors_users_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_flows_steps` ADD CONSTRAINT `message_flows_steps_message_flow_id_fkey` FOREIGN KEY (`message_flow_id`) REFERENCES `message_flows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
