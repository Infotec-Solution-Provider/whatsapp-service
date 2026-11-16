-- Application-owned migration; central MySQL >=8 only. No CRM or WhatsApp data migration.
-- The reviewed CLI guards DATABASE() and metadata before executing. No startup DDL.
CREATE TABLE IF NOT EXISTS operator_runtime_policy (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 enabled TINYINT NOT NULL DEFAULT 0, schema_version INT NOT NULL DEFAULT 1,
 revision BIGINT UNSIGNED NOT NULL DEFAULT 1, review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_state (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operator_id INT NOT NULL, state VARCHAR(16) NOT NULL DEFAULT 'available', version BIGINT UNSIGNED NOT NULL DEFAULT 0,
 unavailable_since DATETIME(3) NULL, active_call_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pending_schedule_id BIGINT NULL, pending_call_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, pending_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 pause_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL, reason_id INT NULL, reason_name VARCHAR(255) NULL, reason_snapshot_json LONGTEXT NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY(instance,operator_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_pause_segments (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, operator_id INT NOT NULL,
 reason_id INT NOT NULL, reason_name VARCHAR(255) NOT NULL, max_seconds INT NOT NULL, productive TINYINT NOT NULL,
 started_at DATETIME(3) NOT NULL, ended_at DATETIME(3) NULL, duration_seconds INT NULL, exceeded_seconds INT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(instance,id), UNIQUE KEY operator_runtime_pause_operation(instance,operation_id), KEY operator_runtime_pause_actor(instance,operator_id,started_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_operations (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, actor_id INT NOT NULL, kind VARCHAR(32) NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, result_json LONGTEXT NOT NULL,
 created_at DATETIME(3) NOT NULL, PRIMARY KEY(instance,operation_id), KEY operator_runtime_operation_actor(instance,actor_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_calls (
 sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operator_id INT NOT NULL, direction VARCHAR(12) NOT NULL, number VARCHAR(64) NOT NULL, extension VARCHAR(32) NULL,
 schedule_id BIGINT NULL, customer_id BIGINT NULL, state VARCHAR(24) NOT NULL,
 prepared_at DATETIME(3) NOT NULL, sent_at DATETIME(3) NULL, ringing_at DATETIME(3) NULL, answered_at DATETIME(3) NULL, ended_at DATETIME(3) NULL,
 rating VARCHAR(12) NULL, comment VARCHAR(1000) NULL, review_version INT NOT NULL DEFAULT 0,
 updated_at DATETIME(3) NOT NULL,
 UNIQUE KEY operator_runtime_call_id(instance,id), KEY operator_runtime_call_actor(instance,operator_id,sequence_id), KEY operator_runtime_call_schedule(instance,schedule_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_call_events (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 call_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, operator_id INT NOT NULL, type VARCHAR(24) NOT NULL,
 occurred_at DATETIME(3) NOT NULL, received_at DATETIME(3) NOT NULL, detail VARCHAR(1000) NULL, sip_call_id VARCHAR(255) NULL,
 PRIMARY KEY(instance,id), KEY operator_runtime_event_call(instance,call_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_phone_intents (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 operator_id INT NOT NULL, schedule_id BIGINT NOT NULL, call_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
 kind VARCHAR(32) NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending', snapshot_json LONGTEXT NOT NULL,
 expected_json LONGTEXT NOT NULL, observed_json LONGTEXT NULL, error_code VARCHAR(80) NULL,
 created_at DATETIME(3) NOT NULL, checked_at DATETIME(3) NULL, next_attempt_at DATETIME(3) NOT NULL,
 PRIMARY KEY(instance,id), KEY operator_runtime_intent_due(status,next_attempt_at), KEY operator_runtime_intent_actor(instance,operator_id,schedule_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS operator_runtime_web_sessions (
 instance VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, operator_id INT NOT NULL,
 session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, segment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 started_at DATETIME(3) NOT NULL, observed_at DATETIME(3) NOT NULL, ended_at DATETIME(3) NULL,
 PRIMARY KEY(instance,segment_id), KEY operator_runtime_session_actor(instance,operator_id,session_id,observed_at)
) ENGINE=InnoDB;
