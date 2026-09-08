-- Provider-keyed storage intentionally has no FK to messages/internalmessages:
-- reaction events may arrive before their target message. Empty emoji strings
-- are retained tombstones and must not be purged independently of event history.
CREATE TABLE `message_reactions` (
  `id` VARCHAR(191) NOT NULL,
  `instance` VARCHAR(191) NOT NULL,
  `client_id` INTEGER NOT NULL,
  `target_message_id` VARCHAR(255) NOT NULL,
  `actor_id` VARCHAR(191) NOT NULL,
  `from_me` BOOLEAN NOT NULL,
  `emoji` VARCHAR(64) NOT NULL,
  `reacted_at` DATETIME(3) NOT NULL,
  `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `source_event_id` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `message_reaction_scope_target_actor` (`instance`, `client_id`, `target_message_id`, `actor_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
