-- Nullable metadata keeps legacy messages distinguishable from an explicit []
-- (new messages declaring no mentions). Original body and InternalMention/user
-- relations remain unchanged; provider identities never become internal user IDs.
ALTER TABLE `messages` ADD COLUMN `mention_metadata` JSON NULL;
ALTER TABLE `internalmessages` ADD COLUMN `mention_metadata` JSON NULL;
