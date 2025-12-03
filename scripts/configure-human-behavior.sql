-- ============================================
-- Configuração de Comportamento Humano
-- ============================================
-- Este script configura os parâmetros de simulação de comportamento humano
-- para evitar detecção de automação e possíveis banimentos.
--
-- IMPORTANTE: Substitua 'SUA_INSTANCIA' pelo nome real da sua instância!
-- ============================================

-- Ativar comportamento humano (true/false)
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.enabled', 'true')
ON DUPLICATE KEY UPDATE value = 'true';

-- ============================================
-- Velocidade de Leitura (palavras por minuto)
-- ============================================
-- Define quanto tempo o bot "espera" antes de processar uma mensagem recebida
-- Valores recomendados: 200-250 (leitura normal de uma pessoa)

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.reading_speed.min', '200')
ON DUPLICATE KEY UPDATE value = '200';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.reading_speed.max', '250')
ON DUPLICATE KEY UPDATE value = '250';

-- ============================================
-- Tempo de Pensamento (milissegundos)
-- ============================================
-- Delay antes de começar a "digitar" a resposta
-- Valores recomendados: 2000-8000 (2-8 segundos)
-- Para respostas rápidas: 500-2000
-- Para respostas naturais: 5000-15000

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.thinking_time.min', '2000')
ON DUPLICATE KEY UPDATE value = '2000';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.thinking_time.max', '8000')
ON DUPLICATE KEY UPDATE value = '8000';

-- ============================================
-- Velocidade de Digitação (palavras por minuto)
-- ============================================
-- Define quanto tempo o bot aguarda antes de enviar a mensagem
-- Valores recomendados: 40-60 (digitação normal)
-- Para digitação rápida: 80-100
-- Para digitação lenta: 30-45

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.typing_speed.min', '40')
ON DUPLICATE KEY UPDATE value = '40';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.typing_speed.max', '60')
ON DUPLICATE KEY UPDATE value = '60';

-- ============================================
-- Estado de Digitação
-- ============================================
-- Mostra o indicador "digitando..." para o destinatário
-- Recomendado: true (mais natural)

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.send_typing_state', 'true')
ON DUPLICATE KEY UPDATE value = 'true';

-- Duração do estado "digitando..." em milissegundos
-- Valores recomendados: 1000-3000 (1-3 segundos)

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.typing_state_duration.min', '1000')
ON DUPLICATE KEY UPDATE value = '1000';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'SUA_INSTANCIA', NULL, NULL, 'human_behavior.typing_state_duration.max', '3000')
ON DUPLICATE KEY UPDATE value = '3000';

-- ============================================
-- Verificar configuração aplicada
-- ============================================

SELECT 
    `key`, 
    value,
    CASE 
        WHEN `key` LIKE '%speed%' THEN 'palavras/minuto'
        WHEN `key` LIKE '%time%' OR `key` LIKE '%duration%' THEN 'milissegundos'
        WHEN `key` LIKE '%enabled%' OR `key` LIKE '%state%' THEN 'boolean'
        ELSE ''
    END as unidade
FROM parameters 
WHERE instance = 'SUA_INSTANCIA' 
AND `key` LIKE 'human_behavior%'
ORDER BY `key`;

-- ============================================
-- Exemplos de Configurações Alternativas
-- ============================================

-- Para DESABILITAR completamente (não recomendado para produção):
-- UPDATE parameters SET value = 'false' WHERE `key` = 'human_behavior.enabled' AND instance = 'SUA_INSTANCIA';

-- Para MODO RÁPIDO (testes/urgências):
-- UPDATE parameters SET value = '500' WHERE `key` = 'human_behavior.thinking_time.min' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '2000' WHERE `key` = 'human_behavior.thinking_time.max' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '80' WHERE `key` = 'human_behavior.typing_speed.min' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '100' WHERE `key` = 'human_behavior.typing_speed.max' AND instance = 'SUA_INSTANCIA';

-- Para MODO NATURAL (mais seguro contra detecção):
-- UPDATE parameters SET value = '5000' WHERE `key` = 'human_behavior.thinking_time.min' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '15000' WHERE `key` = 'human_behavior.thinking_time.max' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '30' WHERE `key` = 'human_behavior.typing_speed.min' AND instance = 'SUA_INSTANCIA';
-- UPDATE parameters SET value = '45' WHERE `key` = 'human_behavior.typing_speed.max' AND instance = 'SUA_INSTANCIA';
