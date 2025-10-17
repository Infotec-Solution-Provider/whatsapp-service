-- Migration: 20251017_add_flow_config_fields
-- Descrição: Adiciona novos campos ao sistema de fluxos para suportar configuração avançada
-- Autor: GitHub Copilot
-- Data: 2025-10-17

-- ==============================================
-- PASSO 1: Adicionar novos campos à tabela de steps
-- ==============================================

-- Adiciona campos de configuração avançada
ALTER TABLE message_flows_steps 
  ADD COLUMN IF NOT EXISTS config JSONB DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS next_step_id INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS fallback_step_id INTEGER DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS description TEXT DEFAULT NULL;

-- Criar índice para consultas por flow e enabled
CREATE INDEX IF NOT EXISTS idx_message_flows_steps_flow_enabled 
  ON message_flows_steps(message_flow_id, enabled);

-- ==============================================
-- PASSO 2: Criar tabela de métricas
-- ==============================================

CREATE TABLE IF NOT EXISTS message_flow_metrics (
  id SERIAL PRIMARY KEY,
  flow_id INTEGER NOT NULL,
  step_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  result VARCHAR(50) NOT NULL,
  error TEXT DEFAULT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_metrics_flow_timestamp 
  ON message_flow_metrics(flow_id, timestamp);
  
CREATE INDEX IF NOT EXISTS idx_metrics_step_result 
  ON message_flow_metrics(step_id, result);

-- ==============================================
-- PASSO 3: Criar tabela de versões de fluxo
-- ==============================================

CREATE TABLE IF NOT EXISTS message_flow_versions (
  id SERIAL PRIMARY KEY,
  flow_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  config JSONB NOT NULL,
  created_by INTEGER DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  description TEXT DEFAULT NULL,
  
  CONSTRAINT unique_flow_version UNIQUE (flow_id, version)
);

-- ==============================================
-- PASSO 4: Adicionar novos tipos ao enum
-- ==============================================

-- Adiciona novos tipos de step ao enum (se não existirem)
DO $$ 
BEGIN
  -- Steps genéricos
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'CONDITION' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'CONDITION';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'QUERY' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'QUERY';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ROUTER' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'ROUTER';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'ASSIGN' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'ASSIGN';
  END IF;
  
  -- Steps específicos adicionais
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SEND_TO_SECTOR_USER' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'SEND_TO_SECTOR_USER';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'SEND_TO_SPECIFIC_USER' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'SEND_TO_SPECIFIC_USER';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'CHECK_CUSTOMER_CAMPAIGN_TYPE' AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'WppMessageFlowStepType')) THEN
    ALTER TYPE "WppMessageFlowStepType" ADD VALUE 'CHECK_CUSTOMER_CAMPAIGN_TYPE';
  END IF;
END $$;

-- ==============================================
-- PASSO 5: Migrar dados existentes
-- ==============================================

-- Atualiza next_step_id baseado na ordem sequencial existente
WITH step_order AS (
  SELECT 
    id,
    message_flow_id,
    step_number,
    LEAD(step_number) OVER (
      PARTITION BY message_flow_id 
      ORDER BY step_number
    ) as next_step
  FROM message_flows_steps
)
UPDATE message_flows_steps mfs
SET next_step_id = step_order.next_step
FROM step_order
WHERE mfs.id = step_order.id;

-- Configurações padrão vazias para steps existentes
UPDATE message_flows_steps 
SET config = '{}'::jsonb
WHERE config IS NULL;

-- ==============================================
-- PASSO 6: Criar snapshots iniciais dos fluxos
-- ==============================================

-- Cria versão 1 para todos os fluxos existentes
INSERT INTO message_flow_versions (flow_id, version, config, description)
SELECT 
  mf.id,
  1 as version,
  json_build_object(
    'flowId', mf.id,
    'instance', mf.instance,
    'sectorId', mf.sector_id,
    'description', mf.description,
    'steps', (
      SELECT json_agg(
        json_build_object(
          'id', step_number,
          'type', type::text,
          'config', COALESCE(config, '{}'::jsonb),
          'nextStepId', next_step_id,
          'enabled', enabled
        ) ORDER BY step_number
      )
      FROM message_flows_steps
      WHERE message_flow_id = mf.id
    )
  ) as config,
  'Versão inicial (migração automática)' as description
FROM message_flows mf
ON CONFLICT (flow_id, version) DO NOTHING;

-- ==============================================
-- PASSO 7: Validações
-- ==============================================

-- Verificar se todas as colunas foram criadas
DO $$
DECLARE
  missing_columns TEXT[];
BEGIN
  SELECT array_agg(column_name)
  INTO missing_columns
  FROM (
    SELECT unnest(ARRAY['config', 'next_step_id', 'fallback_step_id', 'enabled', 'description']) AS column_name
  ) expected
  WHERE column_name NOT IN (
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'message_flows_steps'
  );
  
  IF array_length(missing_columns, 1) > 0 THEN
    RAISE EXCEPTION 'Migração falhou: Colunas não criadas: %', array_to_string(missing_columns, ', ');
  ELSE
    RAISE NOTICE 'Migração concluída com sucesso! Todas as colunas foram criadas.';
  END IF;
END $$;

-- Verificar se as tabelas foram criadas
DO $$
DECLARE
  missing_tables TEXT[];
BEGIN
  SELECT array_agg(table_name)
  INTO missing_tables
  FROM (
    SELECT unnest(ARRAY['message_flow_metrics', 'message_flow_versions']) AS table_name
  ) expected
  WHERE table_name NOT IN (
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
  );
  
  IF array_length(missing_tables, 1) > 0 THEN
    RAISE EXCEPTION 'Migração falhou: Tabelas não criadas: %', array_to_string(missing_tables, ', ');
  ELSE
    RAISE NOTICE 'Todas as tabelas foram criadas com sucesso!';
  END IF;
END $$;

-- ==============================================
-- Informações úteis pós-migração
-- ==============================================

-- Mostrar estatísticas
SELECT 
  'Steps configurados' as metrica,
  COUNT(*) as total
FROM message_flows_steps
WHERE config IS NOT NULL

UNION ALL

SELECT 
  'Fluxos com versão',
  COUNT(DISTINCT flow_id)
FROM message_flow_versions

UNION ALL

SELECT 
  'Steps habilitados',
  COUNT(*)
FROM message_flows_steps
WHERE enabled = TRUE;
