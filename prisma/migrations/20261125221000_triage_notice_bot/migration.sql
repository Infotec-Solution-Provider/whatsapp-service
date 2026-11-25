ALTER TABLE triage_trigger_notices ADD COLUMN bot_id INTEGER NULL;
UPDATE triage_trigger_notices SET bot_id=channel_id WHERE bot_id IS NULL;
