-- Some prepared tenant runtimes store step types as text. Keep existing enum members and their ordinals.
SET @flow_step_type = (SELECT COLUMN_TYPE FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_flows_steps' AND COLUMN_NAME = 'type');
SET @flow_step_ddl = CASE
  WHEN @flow_step_type LIKE 'enum(%' AND LOCATE('''START_BOT''', @flow_step_type) = 0 THEN
    CONCAT('ALTER TABLE `message_flows_steps` MODIFY `type` ', LEFT(@flow_step_type, CHAR_LENGTH(@flow_step_type) - 1), ',''START_BOT'') NOT NULL')
  WHEN @flow_step_type LIKE 'enum(%' OR @flow_step_type LIKE 'varchar(%' OR @flow_step_type IN ('text','longtext') THEN 'DO 0'
  ELSE NULL END;
PREPARE append_start_bot FROM @flow_step_ddl;
EXECUTE append_start_bot;
DEALLOCATE PREPARE append_start_bot;
