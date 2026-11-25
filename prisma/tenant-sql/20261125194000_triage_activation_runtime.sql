ALTER TABLE wpp_runtime_triage_sessions ADD COLUMN run_id INTEGER NULL;
CREATE TABLE wpp_runtime_triage_runs (
 id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(191) NOT NULL,
 chat_id INTEGER NOT NULL, origin_chat_id INTEGER NULL, channel_id INTEGER NOT NULL,
 bot_id INTEGER NOT NULL, version_id INTEGER NOT NULL, event_key VARCHAR(96) NOT NULL,
 kind VARCHAR(20) NOT NULL, actor_id INTEGER NULL, final_state JSON NULL, final_status VARCHAR(20) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ended_at DATETIME(3) NULL,
 UNIQUE INDEX triage_runs_origin_key(instance,event_key),
 INDEX triage_runs_channel_idx(instance,channel_id,created_at), INDEX triage_runs_chat_idx(instance,chat_id,id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
INSERT INTO wpp_runtime_triage_runs (instance,chat_id,channel_id,bot_id,version_id,event_key,kind,created_at,final_status,final_state,ended_at)
 SELECT instance,chat_id,channel_id,bot_id,version_id,CONCAT('legacy:',chat_id),'legacy',created_at,
 IF(status IN ('waiting','handoff'),NULL,status), IF(status IN ('waiting','handoff'),NULL,state),
 IF(status IN ('waiting','handoff'),NULL,updated_at) FROM wpp_runtime_triage_sessions;
UPDATE wpp_runtime_triage_sessions s JOIN wpp_runtime_triage_runs r ON s.chat_id=r.chat_id AND r.kind='legacy' SET s.run_id=r.id;
CREATE TABLE wpp_runtime_triage_trigger_notices (
 id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY, instance VARCHAR(191) NOT NULL, chat_id INTEGER NOT NULL,
 kind VARCHAR(20) NOT NULL, channel_id INTEGER NOT NULL, sector_id INTEGER NOT NULL, user_id INTEGER NULL,
 result_id INTEGER NULL, message_id INTEGER NOT NULL, version_id INTEGER NOT NULL,
 retry_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), attempts INTEGER NOT NULL DEFAULT 0,
 status VARCHAR(20) NOT NULL DEFAULT 'pending', INDEX triage_notice_chat_idx(instance,chat_id,id),
 INDEX triage_notice_retry_idx(status,retry_at,id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE wpp_runtime_triage_events ADD COLUMN run_id INTEGER NULL, ADD INDEX triage_events_run_idx(run_id,id);
UPDATE wpp_runtime_triage_events e JOIN wpp_runtime_triage_sessions s ON e.chat_id=s.chat_id AND e.instance=s.instance SET e.run_id=s.run_id WHERE e.run_id IS NULL;
