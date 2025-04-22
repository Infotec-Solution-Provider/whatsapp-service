-- CreateTable
CREATE TABLE `clients` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `instance` VARCHAR(191) NOT NULL,
    `type` ENUM('WABA', 'WWEBJS') NOT NULL,
    `is_active` BOOLEAN NOT NULL,
    `waba_phone_id` VARCHAR(191) NULL,
    `waba_account_id` VARCHAR(191) NULL,
    `waba_token` VARCHAR(191) NULL,

    INDEX `clients_is_active_idx`(`is_active`),
    UNIQUE INDEX `clients_instance_name_key`(`instance`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `customer_id` INTEGER NULL,
    `instance` VARCHAR(191) NOT NULL,
    `is_blocked` BOOLEAN NOT NULL DEFAULT false,
    `is_only_admin` BOOLEAN NOT NULL DEFAULT false,

    INDEX `contacts_customer_id_instance_idx`(`customer_id`, `instance`),
    UNIQUE INDEX `contacts_instance_phone_key`(`instance`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `wwebjs_id` VARCHAR(191) NULL,
    `waba_id` VARCHAR(191) NULL,
    `from` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quoted_id` INTEGER NULL,
    `chat_id` INTEGER NULL,
    `contact_id` INTEGER NULL,
    `body` VARCHAR(191) NOT NULL,
    `timestamp` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR') NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `file_type` VARCHAR(191) NULL,
    `file_size` VARCHAR(191) NULL,

    UNIQUE INDEX `messages_wwebjs_id_key`(`wwebjs_id`),
    UNIQUE INDEX `messages_waba_id_key`(`waba_id`),
    INDEX `messages_from_to_chat_id_idx`(`from`, `to`, `chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `contact_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `wallet_id` INTEGER NULL,
    `bot_id` INTEGER NULL,
    `result_id` INTEGER NULL,
    `sector_id` INTEGER NULL,
    `type` ENUM('RECEPTIVE', 'ACTIVE') NOT NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'URGENCY') NOT NULL DEFAULT 'NORMAL',
    `avatar_url` VARCHAR(191) NULL,
    `is_finished` BOOLEAN NOT NULL DEFAULT false,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,

    INDEX `chats_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sectors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `wpp_instance_id` INTEGER NULL,
    `start_chats` BOOLEAN NOT NULL,
    `receive_chats` BOOLEAN NOT NULL,

    UNIQUE INDEX `sectors_instance_name_key`(`instance`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sectors_users` (
    `instance` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NOT NULL,
    `sector_id` INTEGER NOT NULL,

    UNIQUE INDEX `sectors_users_user_id_key`(`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flows` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `description` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `message_flows_instance_sector_id_key`(`instance`, `sector_id`),
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
    `instance` VARCHAR(191) NOT NULL,
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
ALTER TABLE `messages` ADD CONSTRAINT `messages_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_wpp_instance_id_fkey` FOREIGN KEY (`wpp_instance_id`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sectors_users` ADD CONSTRAINT `sectors_users_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_flows_steps` ADD CONSTRAINT `message_flows_steps_message_flow_id_fkey` FOREIGN KEY (`message_flow_id`) REFERENCES `message_flows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets_users` ADD CONSTRAINT `wallets_users_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
