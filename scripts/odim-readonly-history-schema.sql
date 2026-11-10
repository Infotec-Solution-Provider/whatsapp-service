CREATE TABLE legacy_readonly_history_snapshots (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 instance VARCHAR(191) NOT NULL,
 manifest_sha CHAR(64) CHARACTER SET ascii NOT NULL,
 source_snapshot_at VARCHAR(32) NOT NULL,
 manifest LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 state ENUM('STAGED','VALIDATED','PUBLISHED') NOT NULL DEFAULT 'STAGED',
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 UNIQUE KEY instance_manifest (instance,manifest_sha),
 KEY published_instance (instance,state,created_at),
 CHECK (JSON_VALID(manifest))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE legacy_readonly_history_rows (
 snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 domain VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_id BIGINT NOT NULL,
 parent_id BIGINT NULL,
 contact_id BIGINT NULL,
 operator_id INT NULL,
 is_finished TINYINT NULL,
 started_civil VARCHAR(32) NULL,
 name_text VARCHAR(255) NULL,
 phone_text VARCHAR(100) NULL,
 payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
 payload_sha CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY (snapshot_id,domain,source_id),
 KEY by_parent (snapshot_id,domain,parent_id,source_id),
 KEY by_contact (snapshot_id,domain,contact_id,source_id),
 KEY by_started (snapshot_id,domain,started_civil,source_id),
 KEY by_finished (snapshot_id,domain,is_finished,source_id),
 CONSTRAINT readonly_history_snapshot_fk FOREIGN KEY(snapshot_id) REFERENCES legacy_readonly_history_snapshots(id) ON DELETE RESTRICT,
 CHECK (JSON_VALID(payload))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
