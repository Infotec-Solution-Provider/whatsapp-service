CREATE TABLE triage_channels (
  instance VARCHAR(128) NOT NULL,
  channel_id INT NOT NULL,
  revision INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  definition LONGTEXT NOT NULL,
  edited_by INT NOT NULL,
  edited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  active_version_id INT NULL,
  paused BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (instance, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE triage_versions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  instance VARCHAR(128) NOT NULL,
  channel_id INT NOT NULL,
  number INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  definition LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by INT NOT NULL,
  UNIQUE KEY (instance, channel_id, number),
  FOREIGN KEY (instance, channel_id) REFERENCES triage_channels (instance, channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE triage_grants (
  instance VARCHAR(128) NOT NULL,
  channel_id INT NOT NULL,
  user_id INT NOT NULL,
  user_name VARCHAR(191) NOT NULL,
  PRIMARY KEY (instance, channel_id, user_id),
  KEY (instance, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE triage_audit (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  instance VARCHAR(128) NOT NULL,
  channel_id INT NOT NULL,
  actor_id INT NOT NULL,
  action VARCHAR(20) NOT NULL,
  version_id INT NULL,
  previous_version_id INT NULL,
  target_user_id INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY (instance, channel_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
