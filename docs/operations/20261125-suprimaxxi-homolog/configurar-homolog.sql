-- Execute com o MySQL CLI em modo batch, sem --force, e com o banco explícito.
-- Os dados do CRM e as atribuições nos atendimentos existentes ficam fora deste script.
SET NAMES utf8mb4;

CREATE TEMPORARY TABLE suprimaxxi_restore_guard (
  ok TINYINT NOT NULL,
  CONSTRAINT suprimaxxi_restore_requires_expected_destination CHECK (ok = 1)
) ENGINE=InnoDB;

INSERT INTO suprimaxxi_restore_guard
SELECT COALESCE(
  CAST(DATABASE() AS BINARY) IN ('homolog-crm-suprimaxxi-stage-20261125', 'homolog-crm-suprimaxxi')
  AND CAST(SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS BINARY) = 'homolog', 0
);

CREATE TEMPORARY TABLE suprimaxxi_restore_features ENGINE=InnoDB AS
SELECT `key` FROM wpp_runtime_parameters WHERE 1 = 0;

-- Catálogos em homolog de WhatsApp e frontend. Flag exclusiva da Odim fica fora.
INSERT INTO suprimaxxi_restore_features (`key`) VALUES
  ('feature_ai_agents_enabled'),
  ('feature_ai_enabled'),
  ('feature_ai_settings_enabled'),
  ('feature_ai_supervisor_enabled'),
  ('feature_chat_export_enabled'),
  ('feature_contact_requests_enabled'),
  ('feature_crm_administration_enabled'),
  ('feature_crm_customers_enabled'),
  ('feature_crm_email_enabled'),
  ('feature_crm_imports_enabled'),
  ('feature_crm_sales_enabled'),
  ('feature_crm_satisfaction_enabled'),
  ('feature_crm_units_campaigns_enabled'),
  ('feature_crm_users_enabled'),
  ('feature_customer_profile_tags_enabled'),
  ('feature_frontend_switch_enabled'),
  ('feature_funnels_enabled'),
  ('feature_internal_group_whatsapp_sync_enabled'),
  ('feature_legacy_history_enabled'),
  ('feature_mass_messages_enabled'),
  ('feature_meta_management_enabled'),
  ('feature_new_frontend_enabled'),
  ('feature_parameter_settings_enabled'),
  ('feature_perf_paginated_chat_history_enabled'),
  ('feature_perf_stable_socket_listeners_enabled'),
  ('feature_perf_virtualized_chat_list_enabled'),
  ('feature_reports_advanced_enabled'),
  ('feature_reports_dashboards_enabled'),
  ('feature_sales_reports_enabled'),
  ('feature_sip_config_enabled'),
  ('feature_telephony_dialer_enabled'),
  ('feature_telephony_monitoring_enabled'),
  ('feature_whatsapp_session_monitoring_enabled');

CREATE TEMPORARY TABLE suprimaxxi_restore_feature_ids (
  id INT PRIMARY KEY
) ENGINE=InnoDB;

CREATE TEMPORARY TABLE suprimaxxi_restore_routes (
  client_id INT PRIMARY KEY,
  sector_id INT NOT NULL,
  previous_link_count INT NOT NULL,
  active_admins INT NOT NULL
) ENGINE=InnoDB;

SET @suprimaxxi_previous_increment = @@SESSION.auto_increment_increment;
SET @suprimaxxi_previous_offset = @@SESSION.auto_increment_offset;
SET @suprimaxxi_previous_time_zone = @@SESSION.time_zone;
SET SESSION auto_increment_increment = 2, auto_increment_offset = 2, time_zone = '+00:00';

START TRANSACTION;

INSERT INTO suprimaxxi_restore_guard
SELECT EXISTS (SELECT 1 FROM wpp_runtime_clients WHERE instance = 'suprimaxxi')
  AND EXISTS (SELECT 1 FROM wpp_runtime_sectors WHERE instance = 'suprimaxxi')
  AND NOT EXISTS (SELECT 1 FROM wpp_runtime_clients WHERE instance <> 'suprimaxxi')
  AND NOT EXISTS (SELECT 1 FROM wpp_runtime_sectors WHERE instance <> 'suprimaxxi')
  AND NOT EXISTS (SELECT 1 FROM wpp_runtime_message_flows WHERE instance <> 'suprimaxxi')
  AND NOT EXISTS (SELECT 1 FROM wpp_runtime_parameters WHERE instance <> 'suprimaxxi');

-- Uma associação existente é preservada. Entre várias, usa um setor com
-- administração ativa e dá preferência ao vínculo em que o canal é o padrão.
-- Se o canal veio sem vínculo, aplica o mesmo critério aos setores da cópia.
INSERT INTO suprimaxxi_restore_routes (client_id, sector_id, previous_link_count, active_admins)
WITH links AS (
  SELECT association.A AS client_id, COUNT(*) AS linked_sectors
  FROM wpp_runtime__sector_clients association
  JOIN wpp_runtime_sectors sector
    ON sector.id = association.B AND sector.instance = 'suprimaxxi'
  GROUP BY association.A
), admins AS (
  SELECT SETOR AS sector_id, COUNT(*) AS active_admins
  FROM operadores
  WHERE NIVEL = 'ADMIN' AND ATIVO = 'SIM'
  GROUP BY SETOR
), candidate_routes AS (
  SELECT
    client.id AS client_id,
    sector.id AS sector_id,
    COALESCE(links.linked_sectors, 0) AS previous_link_count,
    COALESCE(admins.active_admins, 0) AS active_admins,
    ROW_NUMBER() OVER (
      PARTITION BY client.id
      ORDER BY
        (COALESCE(admins.active_admins, 0) > 0) DESC,
        (sector.default_client_id <=> client.id) DESC,
        sector.receive_chats DESC,
        sector.id
    ) AS preference
  FROM wpp_runtime_clients client
  JOIN wpp_runtime_sectors sector ON sector.instance = client.instance
  LEFT JOIN links ON links.client_id = client.id
  LEFT JOIN admins ON admins.sector_id = sector.id
  LEFT JOIN wpp_runtime__sector_clients association
    ON association.A = client.id AND association.B = sector.id
  WHERE client.instance = 'suprimaxxi'
    AND (association.A IS NOT NULL OR links.client_id IS NULL)
)
SELECT client_id, sector_id, previous_link_count, active_admins
FROM candidate_routes WHERE preference = 1;

SELECT client_id, sector_id, previous_link_count, active_admins
FROM suprimaxxi_restore_routes
ORDER BY client_id;

INSERT INTO suprimaxxi_restore_guard
SELECT COUNT(*) = (SELECT COUNT(*) FROM wpp_runtime_clients WHERE instance = 'suprimaxxi')
  AND COALESCE(MIN(active_admins), 0) > 0
FROM suprimaxxi_restore_routes;

DELETE association
FROM wpp_runtime__sector_clients association
JOIN suprimaxxi_restore_routes route ON route.client_id = association.A
WHERE route.sector_id <> association.B;

INSERT INTO wpp_runtime__sector_clients (A, B)
SELECT route.client_id, route.sector_id
FROM suprimaxxi_restore_routes route
LEFT JOIN wpp_runtime__sector_clients association
  ON association.A = route.client_id AND association.B = route.sector_id
WHERE association.A IS NULL;

-- A chave composta do Prisma aceita duplicatas quando setor e usuário são NULL.
-- Retém o menor ID canônico e remove configurações por operador/setor e duplicatas.
INSERT INTO suprimaxxi_restore_feature_ids (id)
SELECT MIN(parameter.id)
FROM wpp_runtime_parameters parameter
JOIN suprimaxxi_restore_features feature ON feature.`key` = parameter.`key`
WHERE parameter.instance = 'suprimaxxi'
  AND parameter.scope = 'INSTANCE'
  AND parameter.sectorId IS NULL AND parameter.userId IS NULL
GROUP BY parameter.`key`;

DELETE parameter
FROM wpp_runtime_parameters parameter
LEFT JOIN suprimaxxi_restore_feature_ids canonical ON canonical.id = parameter.id
WHERE canonical.id IS NULL;

UPDATE wpp_runtime_parameters
SET value = 'true'
WHERE CAST(value AS BINARY) <> 'true';

INSERT INTO wpp_runtime_parameters (scope, `key`, value, instance, sectorId, userId)
SELECT 'INSTANCE', feature.`key`, 'true', 'suprimaxxi', NULL, NULL
FROM suprimaxxi_restore_features feature
LEFT JOIN wpp_runtime_parameters parameter ON parameter.`key` = feature.`key`
WHERE parameter.id IS NULL
ORDER BY feature.`key`;

-- Todo setor, inclusive os de transferência, usa o mesmo passo nativo.
SET @suprimaxxi_flow_label = 'Encaminhar para supervisao em homologacao';

UPDATE wpp_runtime_message_flows flow
JOIN wpp_runtime_sectors sector ON sector.id = flow.sector_id AND sector.instance = flow.instance
SET flow.description = @suprimaxxi_flow_label, flow.updated_at = UTC_TIMESTAMP(3)
WHERE flow.instance = 'suprimaxxi'
  AND NOT (CAST(flow.description AS BINARY) <=> CAST(@suprimaxxi_flow_label AS BINARY));

INSERT INTO wpp_runtime_message_flows (instance, sector_id, description, created_at, updated_at)
SELECT sector.instance, sector.id, @suprimaxxi_flow_label, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM wpp_runtime_sectors sector
LEFT JOIN wpp_runtime_message_flows flow ON flow.instance = sector.instance AND flow.sector_id = sector.id
WHERE sector.instance = 'suprimaxxi' AND flow.id IS NULL
ORDER BY sector.id;

DELETE step
FROM wpp_runtime_message_flows_steps step
JOIN wpp_runtime_message_flows flow ON flow.id = step.message_flow_id
WHERE flow.instance = 'suprimaxxi' AND step.step_number <> 1;

UPDATE wpp_runtime_message_flows_steps step
JOIN wpp_runtime_message_flows flow ON flow.id = step.message_flow_id
SET step.type = 'SEND_TO_ADMIN', step.config = NULL, step.connections = NULL,
    step.next_step_id = NULL, step.fallback_step_id = NULL, step.enabled = 1,
    step.description = @suprimaxxi_flow_label, step.updated_at = UTC_TIMESTAMP(3)
WHERE flow.instance = 'suprimaxxi'
  AND (
    step.type <> 'SEND_TO_ADMIN' OR step.config IS NOT NULL OR step.connections IS NOT NULL
    OR step.next_step_id IS NOT NULL OR step.fallback_step_id IS NOT NULL OR step.enabled <> 1
    OR NOT (CAST(step.description AS BINARY) <=> CAST(@suprimaxxi_flow_label AS BINARY))
  );

INSERT INTO wpp_runtime_message_flows_steps
  (type, message_flow_id, step_number, enabled, description, created_at, updated_at)
SELECT 'SEND_TO_ADMIN', flow.id, 1, 1, @suprimaxxi_flow_label, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
FROM wpp_runtime_message_flows flow
LEFT JOIN wpp_runtime_message_flows_steps step ON step.message_flow_id = flow.id
WHERE flow.instance = 'suprimaxxi' AND step.id IS NULL
ORDER BY flow.id;

INSERT INTO suprimaxxi_restore_guard
SELECT (SELECT COUNT(*) FROM wpp_runtime_parameters)
       = (SELECT COUNT(*) FROM suprimaxxi_restore_features);

INSERT INTO suprimaxxi_restore_guard
SELECT NOT EXISTS (
    SELECT 1 FROM wpp_runtime_parameters parameter
    LEFT JOIN suprimaxxi_restore_features feature ON feature.`key` = parameter.`key`
    WHERE feature.`key` IS NULL OR parameter.scope <> 'INSTANCE' OR CAST(parameter.value AS BINARY) <> 'true'
      OR NOT (parameter.instance <=> 'suprimaxxi')
      OR parameter.sectorId IS NOT NULL OR parameter.userId IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM suprimaxxi_restore_routes route
    LEFT JOIN wpp_runtime__sector_clients association ON association.A = route.client_id
    GROUP BY route.client_id, route.sector_id
    HAVING COUNT(association.A) <> 1 OR MAX(association.B) <> route.sector_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM wpp_runtime_sectors sector
    LEFT JOIN wpp_runtime_message_flows flow
      ON flow.instance = sector.instance AND flow.sector_id = sector.id
    LEFT JOIN wpp_runtime_message_flows_steps step ON step.message_flow_id = flow.id
    WHERE sector.instance = 'suprimaxxi'
    GROUP BY sector.id
    HAVING COUNT(step.id) <> 1 OR SUM(step.step_number = 1 AND step.type = 'SEND_TO_ADMIN' AND step.enabled = 1) <> 1
  );

COMMIT;

SELECT
  DATABASE() AS destination,
  (SELECT COUNT(*) FROM wpp_runtime_parameters WHERE value = 'true') AS enabled_features,
  (SELECT COUNT(*) FROM suprimaxxi_restore_routes) AS inbound_channels,
  (SELECT COUNT(*) FROM wpp_runtime_sectors WHERE instance = 'suprimaxxi') AS supervision_flows;

SET SESSION auto_increment_offset = @suprimaxxi_previous_offset;
SET SESSION auto_increment_increment = @suprimaxxi_previous_increment;
SET SESSION time_zone = @suprimaxxi_previous_time_zone;
DROP TEMPORARY TABLE suprimaxxi_restore_guard, suprimaxxi_restore_features,
  suprimaxxi_restore_feature_ids, suprimaxxi_restore_routes;
