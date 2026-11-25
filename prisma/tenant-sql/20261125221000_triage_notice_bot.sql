ALTER TABLE wpp_runtime_triage_trigger_notices ADD COLUMN bot_id INTEGER NULL;
UPDATE wpp_runtime_triage_trigger_notices SET bot_id=channel_id WHERE bot_id IS NULL;
