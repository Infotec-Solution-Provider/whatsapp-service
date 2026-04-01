CREATE INDEX `messages_instance_sent_at_chat_id_idx` ON `messages`(`instance`, `sent_at`, `chat_id`);
CREATE INDEX `messages_instance_chat_id_sent_at_id_idx` ON `messages`(`instance`, `chat_id`, `sent_at`, `id`);

CREATE INDEX `chats_instance_is_finished_finished_at_idx` ON `chats`(`instance`, `is_finished`, `finished_at`);
CREATE INDEX `chats_instance_is_finished_user_id_sector_id_idx` ON `chats`(`instance`, `is_finished`, `user_id`, `sector_id`);
CREATE INDEX `chats_instance_contact_id_is_finished_finished_at_idx` ON `chats`(`instance`, `contact_id`, `is_finished`, `finished_at`);