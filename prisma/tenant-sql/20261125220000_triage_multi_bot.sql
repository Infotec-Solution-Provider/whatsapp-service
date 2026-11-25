CREATE TABLE wpp_runtime_triage_bots (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  instance VARCHAR(128) NOT NULL, channel_id INT NOT NULL,
  default_slot TINYINT NULL, revision INT NOT NULL, name VARCHAR(120) NOT NULL, definition LONGTEXT NOT NULL,
  edited_by INT NOT NULL, edited_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  active_version_id INT NULL, paused BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY triage_bots_default(instance,channel_id,default_slot),
  UNIQUE KEY triage_bots_name(instance,channel_id,name),
  UNIQUE KEY triage_bots_scope(instance,channel_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wpp_runtime_triage_bot_versions (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(128) NOT NULL, channel_id INT NOT NULL, bot_id INT NOT NULL,
  number INT NOT NULL, name VARCHAR(120) NOT NULL, definition LONGTEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), created_by INT NOT NULL,
  UNIQUE KEY triage_bot_versions_number(instance,channel_id,bot_id,number),
  FOREIGN KEY (instance,channel_id,bot_id) REFERENCES wpp_runtime_triage_bots(instance,channel_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE wpp_runtime_triage_audit ADD COLUMN bot_id INT NULL;

INSERT INTO wpp_runtime_triage_bots(id,instance,channel_id,default_slot,revision,name,definition,edited_by,edited_at,active_version_id,paused)
SELECT c.channel_id,c.instance,c.channel_id,1,c.revision,c.name,c.definition,c.edited_by,c.edited_at,c.active_version_id,c.paused FROM wpp_runtime_triage_channels c
WHERE NOT EXISTS (SELECT 1 FROM wpp_runtime_triage_bots b WHERE b.instance=c.instance AND b.channel_id=c.channel_id AND b.default_slot=1);

INSERT INTO wpp_runtime_triage_bot_versions(id,instance,channel_id,bot_id,number,name,definition,created_at,created_by)
SELECT v.id,v.instance,v.channel_id,b.id,v.number,v.name,v.definition,v.created_at,v.created_by FROM wpp_runtime_triage_versions v
JOIN wpp_runtime_triage_bots b ON b.instance=v.instance AND b.channel_id=v.channel_id AND b.default_slot=1
WHERE NOT EXISTS (SELECT 1 FROM wpp_runtime_triage_bot_versions n WHERE n.instance=v.instance AND n.bot_id=b.id AND n.id=v.id);

UPDATE wpp_runtime_triage_audit a JOIN wpp_runtime_triage_bots b ON b.instance=a.instance AND b.channel_id=a.channel_id AND b.default_slot=1
SET a.bot_id=b.id WHERE a.bot_id IS NULL AND a.version_id IS NOT NULL;
