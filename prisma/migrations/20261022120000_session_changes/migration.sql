-- Central MySQL 8 only. Run migration before enabling the API/frontend.
-- Triggers share the writer transaction; a per-instance row lock serializes publication.
-- No message bodies or customer data are copied into the journal.
CREATE TABLE session_change_streams (
 instance VARCHAR(191) NOT NULL PRIMARY KEY,
 epoch CHAR(36) NOT NULL,
 sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
 floor_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE session_changes (
 instance VARCHAR(191) NOT NULL,
 sequence BIGINT UNSIGNED NOT NULL,
 kind VARCHAR(16) NOT NULL,
 entity_id INT NOT NULL,
 chat_id INT NULL,
 previous_user_id INT NULL,
 previous_wallet_id INT NULL,
 previous_sector_id INT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
 PRIMARY KEY (instance, sequence),
 KEY session_changes_created_at_idx (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO session_change_streams (instance, epoch)
 SELECT DISTINCT instance, UUID() FROM clients GROUP BY instance;

CREATE TRIGGER session_changes_messages_insert AFTER INSERT ON messages
FOR EACH ROW
BEGIN
 IF NEW.chat_id IS NOT NULL THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'message', NEW.id, NEW.chat_id, NULL, NULL, NULL
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_messages_update AFTER UPDATE ON messages
FOR EACH ROW
BEGIN
 IF OLD.chat_id IS NOT NULL AND (NOT (OLD.chat_id <=> NEW.chat_id) OR OLD.instance <> NEW.instance) THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (OLD.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id)
   SELECT OLD.instance, sequence, 'message', OLD.id, OLD.chat_id
   FROM session_change_streams WHERE instance = OLD.instance;
 END IF;
 IF NEW.chat_id IS NOT NULL THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'message', NEW.id, NEW.chat_id, NULL, NULL, NULL
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_messages_delete AFTER DELETE ON messages
FOR EACH ROW
BEGIN
 IF OLD.chat_id IS NOT NULL THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (OLD.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT OLD.instance, sequence, 'message', OLD.id, OLD.chat_id, NULL, NULL, NULL
   FROM session_change_streams WHERE instance = OLD.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chats_insert AFTER INSERT ON chats
FOR EACH ROW
BEGIN
 IF TRUE THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'chat', NEW.id, NEW.id, NEW.user_id, NEW.wallet_id, NEW.sector_id
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chats_update AFTER UPDATE ON chats
FOR EACH ROW
BEGIN
 IF OLD.instance <> NEW.instance THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (OLD.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT OLD.instance, sequence, 'chat', OLD.id, OLD.id, OLD.user_id, OLD.wallet_id, OLD.sector_id
   FROM session_change_streams WHERE instance = OLD.instance;
 END IF;
 IF TRUE THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'chat', NEW.id, NEW.id, OLD.user_id, OLD.wallet_id, OLD.sector_id
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chats_delete AFTER DELETE ON chats
FOR EACH ROW
BEGIN
 IF TRUE THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (OLD.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT OLD.instance, sequence, 'chat', OLD.id, OLD.id, OLD.user_id, OLD.wallet_id, OLD.sector_id
   FROM session_change_streams WHERE instance = OLD.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chat_user_preferences_insert AFTER INSERT ON chat_user_preferences
FOR EACH ROW
BEGIN
 IF NEW.chat_type = 'wpp' THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'chat', NEW.chat_id, NEW.chat_id, NEW.user_id, NULL, NULL
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chat_user_preferences_update AFTER UPDATE ON chat_user_preferences
FOR EACH ROW
BEGIN
 IF NEW.chat_type = 'wpp' THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (NEW.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT NEW.instance, sequence, 'chat', NEW.chat_id, NEW.chat_id, OLD.user_id, NULL, NULL
   FROM session_change_streams WHERE instance = NEW.instance;
 END IF;
END;

CREATE TRIGGER session_changes_chat_user_preferences_delete AFTER DELETE ON chat_user_preferences
FOR EACH ROW
BEGIN
 IF OLD.chat_type = 'wpp' THEN
  INSERT INTO session_change_streams (instance, epoch, sequence)
   VALUES (OLD.instance, UUID(), 1)
   ON DUPLICATE KEY UPDATE sequence = sequence + 1;
  INSERT INTO session_changes (instance, sequence, kind, entity_id, chat_id, previous_user_id, previous_wallet_id, previous_sector_id)
   SELECT OLD.instance, sequence, 'chat', OLD.chat_id, OLD.chat_id, OLD.user_id, NULL, NULL
   FROM session_change_streams WHERE instance = OLD.instance;
 END IF;
END;
