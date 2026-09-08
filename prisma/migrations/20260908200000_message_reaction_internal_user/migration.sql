-- Authenticated InPulse operator, separate from the shared WhatsApp actor.
-- Existing reactions remain unattributed; there is no reliable historical backfill.
ALTER TABLE `message_reactions`
  ADD COLUMN `internal_user_id` INTEGER NULL,
  ADD COLUMN `internal_user_name` VARCHAR(191) NULL;
