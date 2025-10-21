-- ==================================================
-- SCRIPT: Criar Fluxo Karsten (TRANSAÇÃO ÚNICA)
-- ==================================================
-- Descrição: Fluxo completo com validações de cliente, fidelização e usuário
-- Uso: Executar uma única vez para criar o fluxo
-- ==================================================

-- Configurações do fluxo
SET @p_instance = 'develop';
SET @p_sector_id = 1;
SET @p_description = 'Fluxo Karsten - Validação completa de fidelização';

-- ===== INÍCIO DA TRANSAÇÃO =====
START TRANSACTION;

-- ===== CRIAR FLUXO =====
INSERT INTO message_flows (instance, sector_id, name, description, created_at, updated_at)
VALUES (@p_instance, @p_sector_id, 'Karsten Flow', @p_description, NOW(), NOW());

SET @flow_id = LAST_INSERT_ID();

SELECT CONCAT('✅ Fluxo criado com ID: ', @flow_id) as status;

-- ===== STEP 1: Verifica se tem customerId =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 1,
     JSON_OBJECT(
       'field', 'contact.customerId',
       'operator', 'exists',
       'value', true,
       'onTrue', 2,
       'onFalse', 12
     ),
     NULL, NULL, TRUE,
     'Verifica se contato está vinculado a um cliente',
     NOW(), NOW());

SELECT '  ✓ Step 1: Verifica customerId' as status;

-- ===== STEP 2: Busca dados do cliente e campanha =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'QUERY', 2,
     JSON_OBJECT(
       'query', 'SELECT c.CODIGO, c.NOME, c.TIPO_CLIENTE, cc.OPERADOR, cc.FIDELIZA, cc.TIPO_CAMPANHA FROM clientes c LEFT JOIN campanhas_clientes cc ON c.CODIGO = cc.CLIENTE WHERE c.CODIGO = ? ORDER BY cc.CODIGO DESC LIMIT 1',
       'params', JSON_ARRAY('${contact.customerId}'),
       'storeAs', 'customer',
       'single', true
     ),
     3, 12, TRUE,
     'Busca dados do cliente, fidelização e tipo de campanha',
     NOW(), NOW());

SELECT '  ✓ Step 2: Busca dados do cliente' as status;

-- ===== STEP 3: Verifica se é cliente inativo (INAT_A ou INAT_R) =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 3,
     JSON_OBJECT(
       'field', 'customer.TIPO_CAMPANHA',
       'operator', 'in',
       'value', JSON_ARRAY('INAT_A', 'INAT_R'),
       'onTrue', 8,
       'onFalse', 4
     ),
     NULL, NULL, TRUE,
     'Verifica se cliente está em campanha de inativo',
     NOW(), NOW());

SELECT '  ✓ Step 3: Verifica tipo de campanha (INAT)' as status;

-- ===== STEP 4: Verifica se tem operador fidelizado =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 4,
     JSON_OBJECT(
       'field', 'customer.OPERADOR',
       'operator', 'exists',
       'value', true,
       'onTrue', 5,
       'onFalse', 13
     ),
     NULL, NULL, TRUE,
     'Verifica se cliente possui operador fidelizado',
     NOW(), NOW());

SELECT '  ✓ Step 4: Verifica fidelização' as status;

-- ===== STEP 5: Verifica se operador é REPRESENTANTE (-2) =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 5,
     JSON_OBJECT(
       'field', 'customer.OPERADOR',
       'operator', 'equals',
       'value', -2,
       'onTrue', 9,
       'onFalse', 6
     ),
     NULL, NULL, TRUE,
     'Verifica se operador é REPRESENTANTE (código -2)',
     NOW(), NOW());

SELECT '  ✓ Step 5: Verifica REPRESENTANTE (-2)' as status;

-- ===== STEP 6: Verifica se operador é AGENDA PUBLICA (0) =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 6,
     JSON_OBJECT(
       'field', 'customer.OPERADOR',
       'operator', 'equals',
       'value', 0,
       'onTrue', 10,
       'onFalse', 14
     ),
     NULL, NULL, TRUE,
     'Verifica se operador é AGENDA PÚBLICA (código 0)',
     NOW(), NOW());

SELECT '  ✓ Step 6: Verifica AGENDA PÚBLICA (0)' as status;

-- ===== STEP 14: Busca dados do operador =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'QUERY', 14,
     JSON_OBJECT(
       'query', 'SELECT CODIGO, NOME, ATIVO, SETOR FROM operadores WHERE CODIGO = ?',
       'params', JSON_ARRAY('${customer.OPERADOR}'),
       'storeAs', 'operator',
       'single', true
     ),
     15, 11, TRUE,
     'Busca dados do operador fidelizado',
     NOW(), NOW());

SELECT '  ✓ Step 14: Busca dados do operador' as status;

-- ===== STEP 15: Verifica se operador está ativo =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CONDITION', 15,
     JSON_OBJECT(
       'field', 'operator.ATIVO',
       'operator', 'equals',
       'value', 'SIM',
       'onTrue', 7,
       'onFalse', 11
     ),
     NULL, NULL, TRUE,
     'Verifica se operador está ativo',
     NOW(), NOW());

SELECT '  ✓ Step 15: Verifica se operador está ATIVO' as status;

-- ===== STEP 7: FINAL - Atribui para operador fidelizado =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 7,
     JSON_OBJECT(
       'userId', '${customer.OPERADOR}',
       'priority', 'HIGH',
       'systemMessage', '✅ Cliente possui fidelização válida. Atribuindo para operador habitual.\n👤 Operador: ${operator.NOME} (${operator.CODIGO})\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para operador fidelizado ativo',
     NOW(), NOW());

SELECT '  ✓ Step 7: FINAL - Atribui fidelizado' as status;

-- ===== STEP 8: FINAL - Cliente inativo =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 8,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'NORMAL',
       'systemMessage', '⚠️ Cliente está INATIVO (campanha ${customer.TIPO_CAMPANHA}). Atribuindo para supervisão.\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para supervisão (cliente inativo)',
     NOW(), NOW());

SELECT '  ✓ Step 8: FINAL - Cliente inativo' as status;

-- ===== STEP 9: FINAL - Representante =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 9,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'NORMAL',
       'systemMessage', '👔 Cliente é de REPRESENTANTE. Atribuindo para supervisão.\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para supervisão (representante)',
     NOW(), NOW());

SELECT '  ✓ Step 9: FINAL - Representante' as status;

-- ===== STEP 10: FINAL - Agenda pública =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 10,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'NORMAL',
       'systemMessage', '📅 Cliente é de AGENDA PÚBLICA. Atribuindo para supervisão.\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para supervisão (agenda pública)',
     NOW(), NOW());

SELECT '  ✓ Step 10: FINAL - Agenda pública' as status;

-- ===== STEP 11: FINAL - Operador inativo =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 11,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'NORMAL',
       'systemMessage', '⏸️ Cliente fidelizado a um operador INATIVO. Atribuindo para supervisão.\n👤 Operador: ${operator.NOME} (${operator.CODIGO})\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para supervisão (operador inativo)',
     NOW(), NOW());

SELECT '  ✓ Step 11: FINAL - Operador inativo' as status;

-- ===== STEP 12: FINAL - Sem cliente vinculado =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 12,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'LOW',
       'systemMessage', '❓ Contato sem cliente vinculado. Atribuindo para supervisão.\n📱 Contato: ${contact.pushName} (${contact.remoteJid})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Atribui para supervisão (sem cliente)',
     NOW(), NOW());

SELECT '  ✓ Step 12: FINAL - Sem cliente' as status;

-- ===== STEP 13: Buscar usuário disponível ou supervisão =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'CHECK_AVAILABLE_USERS', 13,
     JSON_OBJECT(),
     NULL, 16, TRUE,
     'Busca usuário disponível no setor (sem fidelização)',
     NOW(), NOW());

SELECT '  ✓ Step 13: Busca usuário disponível' as status;

-- ===== STEP 16: FINAL - Fallback supervisão =====
INSERT INTO message_flows_steps 
    (message_flow_id, type, step_number, config, next_step_id, fallback_step_id, enabled, description, created_at, updated_at)
VALUES
    (@flow_id, 'ASSIGN', 16,
     JSON_OBJECT(
       'userId', -1,
       'priority', 'NORMAL',
       'systemMessage', '👥 Cliente sem fidelização válida e nenhum usuário disponível. Atribuindo para supervisão.\n📋 Cliente: ${customer.NOME} (${customer.CODIGO})'
     ),
     NULL, NULL, TRUE,
     'FINAL - Fallback para supervisão',
     NOW(), NOW());

SELECT '  ✓ Step 16: FINAL - Fallback supervisão' as status;

-- ===== COMMIT DA TRANSAÇÃO =====
COMMIT;

-- ===== RESUMO FINAL =====
SELECT '═══════════════════════════════════════════════' as status
UNION ALL SELECT '✅ FLUXO KARSTEN CRIADO COM SUCESSO!'
UNION ALL SELECT '═══════════════════════════════════════════════'
UNION ALL SELECT CONCAT('ID do Fluxo:     ', @flow_id)
UNION ALL SELECT CONCAT('Instance:        ', @p_instance)
UNION ALL SELECT CONCAT('Setor:           ', @p_sector_id)
UNION ALL SELECT 'Total de Steps:  14'
UNION ALL SELECT '═══════════════════════════════════════════════'
UNION ALL SELECT ''
UNION ALL SELECT '📌 Estrutura do Fluxo:'
UNION ALL SELECT '  [1] CONDITION  → Verifica customerId'
UNION ALL SELECT '  [2] QUERY      → Busca dados do cliente'
UNION ALL SELECT '  [3] CONDITION  → Verifica tipo INAT'
UNION ALL SELECT '  [4] CONDITION  → Verifica fidelização'
UNION ALL SELECT '  [5] CONDITION  → Verifica REPRESENTANTE (-2)'
UNION ALL SELECT '  [6] CONDITION  → Verifica AGENDA PÚBLICA (0)'
UNION ALL SELECT '  [14] QUERY     → Busca dados do operador'
UNION ALL SELECT '  [15] CONDITION → Verifica operador ATIVO'
UNION ALL SELECT '  [7] ASSIGN     → FINAL - Fidelizado válido'
UNION ALL SELECT '  [8] ASSIGN     → FINAL - Cliente inativo'
UNION ALL SELECT '  [9] ASSIGN     → FINAL - Representante'
UNION ALL SELECT '  [10] ASSIGN    → FINAL - Agenda pública'
UNION ALL SELECT '  [11] ASSIGN    → FINAL - Operador inativo'
UNION ALL SELECT '  [12] ASSIGN    → FINAL - Sem cliente'
UNION ALL SELECT '  [13] CHECK_AVAILABLE_USERS → Busca disponível'
UNION ALL SELECT '  [16] ASSIGN    → FINAL - Fallback supervisão'
UNION ALL SELECT ''
UNION ALL SELECT '🎯 Próximos passos:'
UNION ALL SELECT '  1. Ajuste @p_instance e @p_sector_id se necessário'
UNION ALL SELECT '  2. Teste o fluxo com diferentes cenários'
UNION ALL SELECT '  3. Monitore métricas na tabela message_flow_metrics';

-- ===== CONSULTAS ÚTEIS =====

-- Ver o fluxo criado
SELECT 
    mf.id,
    mf.instance,
    mf.sector_id,
    mf.name,
    mf.description,
    COUNT(mfs.id) as total_steps,
    mf.created_at
FROM message_flows mf
LEFT JOIN message_flows_steps mfs ON mf.id = mfs.message_flow_id
WHERE mf.id = @flow_id
GROUP BY mf.id, mf.instance, mf.sector_id, mf.name, mf.description, mf.created_at;

-- Ver todos os steps do fluxo criado
SELECT 
    mfs.step_number,
    mfs.type,
    mfs.description,
    mfs.enabled,
    mfs.next_step_id,
    mfs.fallback_step_id,
    JSON_PRETTY(mfs.config) as config
FROM message_flows_steps mfs
WHERE mfs.message_flow_id = @flow_id
ORDER BY mfs.step_number;
