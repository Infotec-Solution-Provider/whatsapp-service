-- Migration: Mover conexões de config para connections
-- Data: 2025-10-17
-- Descrição: Separa as conexões condicionais do config JSON para o campo connections

-- Atualizar steps do tipo CONDITION
UPDATE wpp_message_flow_steps
SET connections = JSON_OBJECT(
    'onTrue', JSON_EXTRACT(config, '$.onTrue'),
    'onFalse', JSON_EXTRACT(config, '$.onFalse')
),
config = JSON_REMOVE(config, '$.onTrue', '$.onFalse')
WHERE type = 'CONDITION'
  AND (JSON_EXTRACT(config, '$.onTrue') IS NOT NULL OR JSON_EXTRACT(config, '$.onFalse') IS NOT NULL);

-- Atualizar steps do tipo ROUTER
UPDATE wpp_message_flow_steps
SET connections = JSON_OBJECT(
    'routes', JSON_EXTRACT(config, '$.routes'),
    'defaultRoute', JSON_EXTRACT(config, '$.default')
),
config = JSON_REMOVE(config, '$.routes', '$.default')
WHERE type = 'ROUTER'
  AND (JSON_EXTRACT(config, '$.routes') IS NOT NULL OR JSON_EXTRACT(config, '$.default') IS NOT NULL);

-- Verificar migração
SELECT 
    id,
    type,
    step_number,
    config,
    connections
FROM wpp_message_flow_steps
WHERE type IN ('CONDITION', 'ROUTER')
ORDER BY message_flow_id, step_number;
