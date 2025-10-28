-- ============================================
-- Script de Configuração do Bot de Vinculação de Cliente
-- ============================================

-- Este script configura os parâmetros necessários para ativar o bot
-- de vinculação de cliente por CNPJ

-- ============================================
-- 1. HABILITAR O BOT PARA UMA INSTÂNCIA
-- ============================================

-- Substitua 'nome_da_instancia' pelo nome real da sua instância
-- Exemplo: 'exatron', 'vollo', etc.

INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'nome_da_instancia', NULL, NULL, 'customer_linking_bot_enabled', 'true')
ON DUPLICATE KEY UPDATE `value` = 'true';

-- ============================================
-- 2. CONFIGURAR TIMEOUT (OPCIONAL)
-- ============================================

-- Timeout padrão: 10 minutos (600000 ms)
-- Ajuste o valor conforme necessário

INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'nome_da_instancia', NULL, NULL, 'customer_linking_timeout_ms', '600000')
ON DUPLICATE KEY UPDATE `value` = '600000';

-- ============================================
-- EXEMPLOS DE CONFIGURAÇÃO POR ESCOPO
-- ============================================

-- ----------------------------------------
-- Exemplo 1: Habilitar para instância específica
-- ----------------------------------------
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'exatron', NULL, NULL, 'customer_linking_bot_enabled', 'true')
ON DUPLICATE KEY UPDATE `value` = 'true';

-- ----------------------------------------
-- Exemplo 2: Habilitar para setor específico
-- ----------------------------------------
-- Substitua '5' pelo ID do setor desejado
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('SECTOR', 'exatron', 5, NULL, 'customer_linking_bot_enabled', 'true')
ON DUPLICATE KEY UPDATE `value` = 'true';

-- ----------------------------------------
-- Exemplo 3: Habilitar para usuário específico
-- ----------------------------------------
-- Substitua '10' pelo ID do usuário desejado
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('USER', 'exatron', 5, 10, 'customer_linking_bot_enabled', 'true')
ON DUPLICATE KEY UPDATE `value` = 'true';

-- ----------------------------------------
-- Exemplo 4: Timeout de 5 minutos (300000 ms)
-- ----------------------------------------
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'exatron', NULL, NULL, 'customer_linking_timeout_ms', '300000')
ON DUPLICATE KEY UPDATE `value` = '300000';

-- ----------------------------------------
-- Exemplo 5: Timeout de 15 minutos (900000 ms)
-- ----------------------------------------
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'exatron', NULL, NULL, 'customer_linking_timeout_ms', '900000')
ON DUPLICATE KEY UPDATE `value` = '900000';

-- ============================================
-- CONSULTAS ÚTEIS
-- ============================================

-- Ver todos os parâmetros do bot
SELECT * FROM parameters 
WHERE `key` LIKE 'customer_linking%'
ORDER BY scope, instance, sectorId, userId;

-- Ver configuração de uma instância específica
SELECT * FROM parameters 
WHERE instance = 'exatron' 
  AND `key` LIKE 'customer_linking%';

-- Ver se o bot está habilitado
SELECT scope, instance, sectorId, userId, `value` as enabled
FROM parameters 
WHERE `key` = 'customer_linking_bot_enabled';

-- ============================================
-- DESABILITAR O BOT
-- ============================================

-- Desabilitar para uma instância
UPDATE parameters 
SET `value` = 'false' 
WHERE instance = 'nome_da_instancia' 
  AND `key` = 'customer_linking_bot_enabled';

-- Remover configuração completamente
DELETE FROM parameters 
WHERE instance = 'nome_da_instancia' 
  AND `key` LIKE 'customer_linking%';

-- ============================================
-- VERIFICAÇÕES
-- ============================================

-- Verificar se existem contatos sem cliente vinculado
SELECT instance, COUNT(*) as total
FROM contacts 
WHERE customer_id IS NULL 
  AND is_deleted = 0
GROUP BY instance;

-- Verificar tabela de clientes (adaptar conforme sua estrutura)
-- Esta query precisa ser executada no banco de dados da instância
/*
SELECT COUNT(*) as total_clientes
FROM clientes 
WHERE CPF_CNPJ IS NOT NULL 
  AND CPF_CNPJ != '';
*/

-- ============================================
-- VALORES RECOMENDADOS
-- ============================================

-- customer_linking_bot_enabled:
--   'true' ou '1' = Bot habilitado
--   'false' ou '0' = Bot desabilitado

-- customer_linking_timeout_ms (em milissegundos):
--   300000  = 5 minutos
--   600000  = 10 minutos (padrão)
--   900000  = 15 minutos
--   1800000 = 30 minutos

-- ============================================
-- HIERARQUIA DE PRIORIDADE DOS PARÂMETROS
-- ============================================

-- 1. USER (maior prioridade)
-- 2. SECTOR
-- 3. INSTANCE (menor prioridade)

-- Se configurado em múltiplos escopos, o valor mais específico será usado.

-- Exemplo:
-- INSTANCE: enabled = true
-- SECTOR:   enabled = false
-- USER:     enabled = true
-- Resultado: Bot HABILITADO para o usuário (USER tem prioridade)
