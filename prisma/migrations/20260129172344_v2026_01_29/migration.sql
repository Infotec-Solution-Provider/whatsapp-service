-- CreateTable
CREATE TABLE `clients` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `instance` VARCHAR(191) NOT NULL,
    `type` ENUM('WABA', 'WWEBJS', 'GUPSHUP', 'REMOTE') NOT NULL,
    `is_active` BOOLEAN NOT NULL,
    `waba_phone_id` VARCHAR(191) NULL,
    `waba_account_id` VARCHAR(191) NULL,
    `waba_token` VARCHAR(191) NULL,
    `gupshup_token` VARCHAR(191) NULL,
    `gupshup_app_name` VARCHAR(191) NULL,
    `gupshup_app_id` VARCHAR(191) NULL,
    `remote_client_url` VARCHAR(191) NULL,

    INDEX `clients_is_active_idx`(`is_active`),
    UNIQUE INDEX `clients_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `customer_id` INTEGER NULL,
    `instance` VARCHAR(191) NOT NULL,
    `is_deleted` BOOLEAN NOT NULL DEFAULT false,
    `is_blocked` BOOLEAN NOT NULL DEFAULT false,
    `is_only_admin` BOOLEAN NOT NULL DEFAULT false,
    `avatar_url` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NULL,
    `last_out_of_hours_reply_sent_at` DATETIME(3) NULL,
    `conversation_expiration` VARCHAR(191) NULL,

    INDEX `contacts_customer_id_instance_idx`(`customer_id`, `instance`),
    UNIQUE INDEX `contacts_instance_phone_key`(`instance`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `wwebjs_id` VARCHAR(191) NULL,
    `wwebjs_id_stanza` VARCHAR(191) NULL,
    `waba_id` VARCHAR(191) NULL,
    `gupshup_id` VARCHAR(191) NULL,
    `gupshup_request_id` VARCHAR(191) NULL,
    `from` VARCHAR(191) NOT NULL,
    `to` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quoted_id` INTEGER NULL,
    `chat_id` INTEGER NULL,
    `contact_id` INTEGER NULL,
    `is_forwarded` BOOLEAN NOT NULL DEFAULT false,
    `is_edited` BOOLEAN NOT NULL DEFAULT false,
    `body` VARCHAR(191) NOT NULL,
    `timestamp` VARCHAR(191) NOT NULL,
    `sent_at` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED') NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `file_type` VARCHAR(191) NULL,
    `file_size` VARCHAR(191) NULL,
    `user_id` INTEGER NULL,
    `billing_category` VARCHAR(191) NULL,
    `client_id` INTEGER NULL,

    UNIQUE INDEX `messages_wwebjs_id_key`(`wwebjs_id`),
    UNIQUE INDEX `messages_wwebjs_id_stanza_key`(`wwebjs_id_stanza`),
    UNIQUE INDEX `messages_waba_id_key`(`waba_id`),
    UNIQUE INDEX `messages_gupshup_id_key`(`gupshup_id`),
    INDEX `messages_from_to_chat_id_idx`(`from`, `to`, `chat_id`),
    INDEX `messages_chat_id_user_id_idx`(`chat_id`, `user_id`),
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
    `schedule_id` INTEGER NULL,
    `type` ENUM('RECEPTIVE', 'ACTIVE') NOT NULL,
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'VERY_HIGH', 'URGENCY') NOT NULL DEFAULT 'NORMAL',
    `avatar_url` TEXT NULL,
    `is_finished` BOOLEAN NOT NULL DEFAULT false,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `finished_by` INTEGER NULL,
    `is_schedule` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `chats_schedule_id_key`(`schedule_id`),
    INDEX `chats_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internalmessages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `from` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `quoted_id` INTEGER NULL,
    `is_forwarded` BOOLEAN NOT NULL,
    `is_edited` BOOLEAN NOT NULL,
    `wwebjs_id` VARCHAR(191) NULL,
    `wwebjs_id_stanza` VARCHAR(191) NULL,
    `internalchat_id` INTEGER NOT NULL,
    `body` VARCHAR(191) NOT NULL,
    `timestamp` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'SENT', 'RECEIVED', 'READ', 'DOWNLOADED', 'ERROR', 'REVOKED') NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `file_type` VARCHAR(191) NULL,
    `file_size` VARCHAR(191) NULL,
    `client_id` INTEGER NULL,

    UNIQUE INDEX `internalmessages_wwebjs_id_key`(`wwebjs_id`),
    UNIQUE INDEX `internalmessages_wwebjs_id_stanza_key`(`wwebjs_id_stanza`),
    INDEX `internalmessages_from_internalchat_id_idx`(`from`, `internalchat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internalchats` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `user_id` INTEGER NULL,
    `sector_id` INTEGER NULL,
    `is_finished` BOOLEAN NOT NULL DEFAULT false,
    `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finished_at` DATETIME(3) NULL,
    `finished_by` INTEGER NULL,
    `is_group` BOOLEAN NOT NULL DEFAULT false,
    `group_name` VARCHAR(191) NULL,
    `group_description` VARCHAR(191) NULL,
    `group_image_file_id` INTEGER NULL,
    `wpp_group_id` VARCHAR(191) NULL,

    UNIQUE INDEX `internalchats_wpp_group_id_key`(`wpp_group_id`),
    INDEX `internalchats_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internal_chat_members` (
    `internalchatId` INTEGER NOT NULL,
    `internalcontactId` INTEGER NOT NULL,
    `joined_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_read_at` DATETIME(3) NULL,

    PRIMARY KEY (`internalchatId`, `internalcontactId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `internal_mentions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `internalmessage_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    INDEX `internal_mentions_internalmessage_id_idx`(`internalmessage_id`),
    INDEX `internal_mentions_user_id_idx`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tags` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bg_color` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `tags_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sectors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `start_chats` BOOLEAN NOT NULL,
    `receive_chats` BOOLEAN NOT NULL,
    `default_client_id` INTEGER NULL,

    UNIQUE INDEX `sectors_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts_sectors` (
    `contactId` INTEGER NOT NULL,
    `sectorId` INTEGER NOT NULL,

    PRIMARY KEY (`contactId`, `sectorId`)
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
    `type` ENUM('CONDITION', 'QUERY', 'ROUTER', 'ASSIGN', 'CHECK_AVAILABLE_USERS', 'CHECK_LOALTY', 'CHECK_ONLY_ADMIN', 'SEND_TO_ADMIN', 'SEND_TO_SECTOR_USER', 'SEND_TO_SPECIFIC_USER', 'CHECK_CUSTOMER_CAMPAIGN_TYPE') NOT NULL,
    `message_flow_id` INTEGER NOT NULL,
    `step_number` INTEGER NOT NULL,
    `config` JSON NULL,
    `connections` JSON NULL,
    `next_step_id` INTEGER NULL,
    `fallback_step_id` INTEGER NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `description` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `message_flows_steps_message_flow_id_enabled_idx`(`message_flow_id`, `enabled`),
    UNIQUE INDEX `message_flows_steps_message_flow_id_step_number_key`(`message_flow_id`, `step_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automatic_response_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `isGlobal` BOOLEAN NOT NULL DEFAULT false,
    `message` TEXT NOT NULL,
    `fileId` INTEGER NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT true,
    `cooldownSeconds` INTEGER NOT NULL DEFAULT 3600,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automatic_response_rule_users` (
    `rule_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    PRIMARY KEY (`rule_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automatic_response_schedules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ruleId` INTEGER NOT NULL,
    `frequency` ENUM('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') NOT NULL DEFAULT 'WEEKLY',
    `daysOfWeek` JSON NULL,
    `dayOfMonth` INTEGER NULL,
    `month` INTEGER NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'America/Fortaleza',
    `startDate` DATETIME(3) NULL,
    `endDate` DATETIME(3) NULL,
    `dayOfWeek` INTEGER NULL,
    `startTime` VARCHAR(191) NOT NULL,
    `endTime` VARCHAR(191) NOT NULL,

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
CREATE TABLE `schedules` (
    `instance` VARCHAR(191) NOT NULL,
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `description` VARCHAR(191) NULL,
    `contact_id` INTEGER NOT NULL,
    `chat_id` INTEGER NULL,
    `scheduled_at` DATETIME(3) NOT NULL,
    `schedule_date` DATETIME(3) NOT NULL,
    `scheduled_by` INTEGER NOT NULL,
    `scheduled_for` INTEGER NOT NULL,
    `sector_id` INTEGER NULL,

    UNIQUE INDEX `schedules_chat_id_key`(`chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wallets_users` (
    `wallet_id` INTEGER NOT NULL,
    `user_id` INTEGER NOT NULL,

    UNIQUE INDEX `wallets_users_wallet_id_user_id_key`(`wallet_id`, `user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `parameters` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scope` ENUM('INSTANCE', 'SECTOR', 'USER') NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NULL,
    `sectorId` INTEGER NULL,
    `userId` INTEGER NULL,

    UNIQUE INDEX `parameters_scope_instance_sectorId_userId_key_key`(`scope`, `instance`, `sectorId`, `userId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `chat_id` INTEGER NULL,
    `user_id` INTEGER NULL,
    `type` ENUM('CHAT_AUTO_FINISHED', 'CHAT_TRANSFERRED', 'CHAT_REASSIGNED', 'ALERT', 'INFO', 'WARNING', 'ERROR') NOT NULL,
    `read` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flow_metrics` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `flow_id` INTEGER NOT NULL,
    `step_id` INTEGER NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `duration_ms` INTEGER NOT NULL,
    `result` VARCHAR(191) NOT NULL,
    `error` VARCHAR(191) NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `message_flow_metrics_flow_id_timestamp_idx`(`flow_id`, `timestamp`),
    INDEX `message_flow_metrics_step_id_result_idx`(`step_id`, `result`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_flow_versions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `flow_id` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `config` JSON NOT NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `description` VARCHAR(191) NULL,

    UNIQUE INDEX `message_flow_versions_flow_id_version_key`(`flow_id`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ready_messages` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `sector_id` INTEGER NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `file_id` INTEGER NULL,
    `file_name` VARCHAR(191) NULL,
    `only_admin` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ready_messages_instance_sector_id_idx`(`instance`, `sector_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_queue_items` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `chat_id` VARCHAR(191) NOT NULL,
    `client_id` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `priority` INTEGER NOT NULL DEFAULT 0,
    `payload` JSON NOT NULL,
    `is_group` BOOLEAN NOT NULL DEFAULT false,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,

    INDEX `message_queue_items_instance_chat_id_status_idx`(`instance`, `chat_id`, `status`),
    INDEX `message_queue_items_status_created_at_idx`(`status`, `created_at`),
    INDEX `message_queue_items_client_id_status_idx`(`client_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `gupshup_webhook_queue` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `redirected` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,

    INDEX `gupshup_webhook_queue_instance_status_idx`(`instance`, `status`),
    INDEX `gupshup_webhook_queue_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wpp_message_processing_queue` (
    `id` VARCHAR(191) NOT NULL,
    `instance` VARCHAR(191) NOT NULL,
    `client_id` INTEGER NOT NULL,
    `message_id` INTEGER NOT NULL,
    `contact_phone` VARCHAR(191) NOT NULL,
    `contact_name` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `processing_started_at` DATETIME(3) NULL,
    `processed_at` DATETIME(3) NULL,
    `locked_until` DATETIME(3) NULL,
    `locked_by` VARCHAR(191) NULL,

    INDEX `wpp_message_processing_queue_instance_status_contact_phone_idx`(`instance`, `status`, `contact_phone`),
    INDEX `wpp_message_processing_queue_status_created_at_idx`(`status`, `created_at`),
    INDEX `wpp_message_processing_queue_contact_phone_status_idx`(`contact_phone`, `status`),
    INDEX `wpp_message_processing_queue_locked_until_idx`(`locked_until`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `process_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instance` VARCHAR(191) NOT NULL,
    `process_name` VARCHAR(191) NOT NULL,
    `process_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL,
    `start_time` DATETIME(3) NOT NULL,
    `end_time` DATETIME(3) NOT NULL,
    `duration` INTEGER NOT NULL,
    `input` LONGTEXT NULL,
    `output` LONGTEXT NULL,
    `error` LONGTEXT NULL,
    `error_message` TEXT NULL,
    `log_entries` LONGTEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `process_logs_instance_process_name_idx`(`instance`, `process_name`),
    INDEX `process_logs_status_created_at_idx`(`status`, `created_at`),
    INDEX `process_logs_instance_status_idx`(`instance`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_sector_clients` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_sector_clients_AB_unique`(`A`, `B`),
    INDEX `_sector_clients_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_WppChatToWppTag` (
    `A` INTEGER NOT NULL,
    `B` INTEGER NOT NULL,

    UNIQUE INDEX `_WppChatToWppTag_AB_unique`(`A`, `B`),
    INDEX `_WppChatToWppTag_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `messages` ADD CONSTRAINT `messages_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chats` ADD CONSTRAINT `chats_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_internalchat_id_fkey` FOREIGN KEY (`internalchat_id`) REFERENCES `internalchats`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalmessages` ADD CONSTRAINT `internalmessages_client_id_fkey` FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internalchats` ADD CONSTRAINT `internalchats_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_chat_members` ADD CONSTRAINT `internal_chat_members_internalchatId_fkey` FOREIGN KEY (`internalchatId`) REFERENCES `internalchats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `internal_mentions` ADD CONSTRAINT `internal_mentions_internalmessage_id_fkey` FOREIGN KEY (`internalmessage_id`) REFERENCES `internalmessages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sectors` ADD CONSTRAINT `sectors_default_client_id_fkey` FOREIGN KEY (`default_client_id`) REFERENCES `clients`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts_sectors` ADD CONSTRAINT `contacts_sectors_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `contacts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `contacts_sectors` ADD CONSTRAINT `contacts_sectors_sectorId_fkey` FOREIGN KEY (`sectorId`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `message_flows_steps` ADD CONSTRAINT `message_flows_steps_message_flow_id_fkey` FOREIGN KEY (`message_flow_id`) REFERENCES `message_flows`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automatic_response_rule_users` ADD CONSTRAINT `automatic_response_rule_users_rule_id_fkey` FOREIGN KEY (`rule_id`) REFERENCES `automatic_response_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `automatic_response_schedules` ADD CONSTRAINT `automatic_response_schedules_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `automatic_response_rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `schedules` ADD CONSTRAINT `schedules_sector_id_fkey` FOREIGN KEY (`sector_id`) REFERENCES `sectors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `wallets_users` ADD CONSTRAINT `wallets_users_wallet_id_fkey` FOREIGN KEY (`wallet_id`) REFERENCES `wallets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_chat_id_fkey` FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_sector_clients` ADD CONSTRAINT `_sector_clients_A_fkey` FOREIGN KEY (`A`) REFERENCES `clients`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_sector_clients` ADD CONSTRAINT `_sector_clients_B_fkey` FOREIGN KEY (`B`) REFERENCES `sectors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_WppChatToWppTag` ADD CONSTRAINT `_WppChatToWppTag_A_fkey` FOREIGN KEY (`A`) REFERENCES `chats`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_WppChatToWppTag` ADD CONSTRAINT `_WppChatToWppTag_B_fkey` FOREIGN KEY (`B`) REFERENCES `tags`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
