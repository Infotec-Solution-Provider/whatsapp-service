CREATE TABLE triage_sessions (
  chat_id INTEGER NOT NULL PRIMARY KEY,
  instance VARCHAR(191) NOT NULL,
  channel_id INTEGER NOT NULL, contact_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
  definition JSON NOT NULL, state JSON NOT NULL,
  status VARCHAR(20) NOT NULL, deadline DATETIME(3) NULL,
  last_message_id INTEGER NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL,
  INDEX triage_sessions_status_deadline_idx (status, deadline),
  INDEX triage_sessions_instance_bot_id_version_id_status_idx (instance, bot_id, version_id, status),
  INDEX triage_sessions_channel_started_idx (instance, channel_id, created_at),
  INDEX triage_sessions_channel_status_idx (instance, channel_id, status, updated_at)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE triage_events (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  instance VARCHAR(191) NOT NULL, chat_id INTEGER NOT NULL,
  event_key VARCHAR(96) NOT NULL, kind VARCHAR(24) NOT NULL, node_id VARCHAR(128) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY triage_events_instance_event_key_key (instance, event_key),
  INDEX triage_events_instance_chat_id_id_idx (instance, chat_id, id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE triage_effects (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(191) NOT NULL,
  chat_id INTEGER NOT NULL, event_id INTEGER NOT NULL, position INTEGER NOT NULL,
  kind VARCHAR(16) NOT NULL, payload JSON NOT NULL, status VARCHAR(20) NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  retry_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), message_id INTEGER NULL,
  error VARCHAR(128) NULL, updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY triage_effects_event_id_position_key (event_id, position),
  INDEX triage_effects_status_retry_at_id_idx (status, retry_at, id),
  INDEX triage_effects_instance_chat_id_status_id_idx (instance, chat_id, status, id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
