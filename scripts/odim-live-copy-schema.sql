CREATE TABLE odim_operational_copy_sync_state (
 instance VARCHAR(191) NOT NULL PRIMARY KEY,
 run_id VARCHAR(36) NOT NULL,
 message_cursor BIGINT NOT NULL,
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE odim_operational_copy_webhooks (
 id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 provider_id VARCHAR(191) NOT NULL,
 kind VARCHAR(16) NOT NULL,
 payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
 attempts INT NOT NULL DEFAULT 0,
 received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 KEY pending_copy_events(state,received_at),
 CONSTRAINT copy_webhook_json CHECK(JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE odim_operational_copy_source_versions (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
 instance VARCHAR(191) NOT NULL,
 domain VARCHAR(40) NOT NULL,
 source_id BIGINT NOT NULL,
 payload_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY copy_source_version(instance,domain,source_id,payload_sha),
 CONSTRAINT copy_source_json CHECK(JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
