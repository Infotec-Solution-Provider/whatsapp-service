-- Scoped archive for the old homolog snapshot. Temporary CHECK aborts the transaction on a mismatch.
CREATE TABLE IF NOT EXISTS wpp_hml_arquivo_20261009_message_flows_steps LIKE `homolog-whatsapp`.message_flows_steps;
CREATE TABLE IF NOT EXISTS wpp_hml_arquivo_20261009_parameters LIKE `homolog-whatsapp`.parameters;
CREATE TABLE IF NOT EXISTS wpp_hml_arquivo_20261009_client_session_events LIKE `homolog-whatsapp`.client_session_events;
CREATE TEMPORARY TABLE archive_verified (ok INT NOT NULL CHECK (ok=1));
START TRANSACTION;
INSERT INTO wpp_hml_arquivo_20261009_message_flows_steps SELECT s.*
  FROM `homolog-whatsapp`.message_flows_steps s JOIN `homolog-whatsapp`.message_flows f ON s.message_flow_id=f.id WHERE f.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_message_flows_steps t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_message_flows_steps t WHERE t.message_flow_id=s.message_flow_id AND t.step_number=s.step_number AND t.type=s.type) AND NOT EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_message_flows_steps a WHERE a.id=s.id);
INSERT INTO wpp_hml_arquivo_20261009_parameters SELECT s.*
  FROM `homolog-whatsapp`.parameters s  WHERE s.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_parameters t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_parameters t WHERE t.instance=s.instance AND t.scope=s.scope AND t.`key`=s.`key` AND (t.userId <=> s.userId) AND (t.sectorId <=> s.sectorId)) AND NOT EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_parameters a WHERE a.id=s.id);
INSERT INTO wpp_hml_arquivo_20261009_client_session_events SELECT s.*
  FROM `homolog-whatsapp`.client_session_events s JOIN `homolog-whatsapp`.clients c ON c.id=s.client_id WHERE c.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_client_session_events t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_client_session_events t WHERE t.client_id=s.client_id AND t.transition_key=s.transition_key) AND NOT EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_client_session_events a WHERE a.id=s.id);
INSERT INTO archive_verified SELECT (SELECT COUNT(*) FROM wpp_hml_arquivo_20261009_message_flows_steps)=17 AND (SELECT COUNT(*)
  FROM `homolog-whatsapp`.message_flows_steps s JOIN `homolog-whatsapp`.message_flows f ON s.message_flow_id=f.id WHERE f.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_message_flows_steps t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_message_flows_steps t WHERE t.message_flow_id=s.message_flow_id AND t.step_number=s.step_number AND t.type=s.type) AND EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_message_flows_steps a WHERE a.id=s.id
        AND (BINARY a.`id` <=> BINARY s.`id`)
        AND (BINARY a.`type` <=> BINARY s.`type`)
        AND (BINARY a.`message_flow_id` <=> BINARY s.`message_flow_id`)
        AND (BINARY a.`step_number` <=> BINARY s.`step_number`)
        AND (BINARY a.`config` <=> BINARY s.`config`)
        AND (BINARY a.`connections` <=> BINARY s.`connections`)
        AND (BINARY a.`next_step_id` <=> BINARY s.`next_step_id`)
        AND (BINARY a.`fallback_step_id` <=> BINARY s.`fallback_step_id`)
        AND (BINARY a.`enabled` <=> BINARY s.`enabled`)
        AND (BINARY a.`description` <=> BINARY s.`description`)
        AND (BINARY a.`created_at` <=> BINARY s.`created_at`)
        AND (BINARY a.`updated_at` <=> BINARY s.`updated_at`)))=17 AND (SELECT COUNT(*) FROM wpp_hml_arquivo_20261009_parameters)=16 AND (SELECT COUNT(*)
  FROM `homolog-whatsapp`.parameters s  WHERE s.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_parameters t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_parameters t WHERE t.instance=s.instance AND t.scope=s.scope AND t.`key`=s.`key` AND (t.userId <=> s.userId) AND (t.sectorId <=> s.sectorId)) AND EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_parameters a WHERE a.id=s.id
        AND (BINARY a.`id` <=> BINARY s.`id`)
        AND (BINARY a.`scope` <=> BINARY s.`scope`)
        AND (BINARY a.`key` <=> BINARY s.`key`)
        AND (BINARY a.`value` <=> BINARY s.`value`)
        AND (BINARY a.`instance` <=> BINARY s.`instance`)
        AND (BINARY a.`sectorId` <=> BINARY s.`sectorId`)
        AND (BINARY a.`userId` <=> BINARY s.`userId`)))=16 AND (SELECT COUNT(*) FROM wpp_hml_arquivo_20261009_client_session_events)=1 AND (SELECT COUNT(*)
  FROM `homolog-whatsapp`.client_session_events s JOIN `homolog-whatsapp`.clients c ON c.id=s.client_id WHERE c.instance='suprimaxxi' AND NOT EXISTS(SELECT 1 FROM wpp_runtime_client_session_events t WHERE t.id=s.id) AND NOT EXISTS(SELECT 1 FROM wpp_runtime_client_session_events t WHERE t.client_id=s.client_id AND t.transition_key=s.transition_key) AND EXISTS(SELECT 1 FROM wpp_hml_arquivo_20261009_client_session_events a WHERE a.id=s.id
        AND (BINARY a.`id` <=> BINARY s.`id`)
        AND (BINARY a.`client_id` <=> BINARY s.`client_id`)
        AND (BINARY a.`previous_state` <=> BINARY s.`previous_state`)
        AND (BINARY a.`state` <=> BINARY s.`state`)
        AND (BINARY a.`reason` <=> BINARY s.`reason`)
        AND (BINARY a.`occurred_at` <=> BINARY s.`occurred_at`)
        AND (BINARY a.`trace_id` <=> BINARY s.`trace_id`)
        AND (BINARY a.`transition_key` <=> BINARY s.`transition_key`)
        AND (BINARY a.`source` <=> BINARY s.`source`)
        AND (BINARY a.`created_at` <=> BINARY s.`created_at`)))=1;
COMMIT;
SELECT 'verified' AS archive,17 AS flow_steps,16 AS parameters_preserved,1 AS session_events;
