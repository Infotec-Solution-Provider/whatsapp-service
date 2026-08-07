-- Add agent_id to chats table
ALTER TABLE `chats` ADD COLUMN `agent_id` INT NULL DEFAULT NULL AFTER `bot_id`;

-- Add agent_id to messages table
ALTER TABLE `messages` ADD COLUMN `agent_id` INT NULL DEFAULT NULL AFTER `user_id`;

-- Indexes for efficient queries
CREATE INDEX `chats_agent_id_idx` ON `chats`(`agent_id`);
CREATE INDEX `messages_agent_id_idx` ON `messages`(`agent_id`);
