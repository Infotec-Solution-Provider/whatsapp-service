-- Script para configurar o parâmetro de busca local na monitoria
-- Este parâmetro controla se a monitoria usa busca local (otimizada) ou padrão

-- Exemplos de uso:

-- 1. Ativar busca local para uma instância específica
-- INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
-- VALUES ('INSTANCE', 'monitor.useLocalSearch', 'true', 'nunes', NULL, NULL)
-- ON DUPLICATE KEY UPDATE value = 'true';

-- 2. Ativar busca local para um setor específico
-- INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
-- VALUES ('SECTOR', 'monitor.useLocalSearch', 'true', NULL, 1, NULL)
-- ON DUPLICATE KEY UPDATE value = 'true';

-- 3. Ativar busca local para um usuário específico
-- INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
-- VALUES ('USER', 'monitor.useLocalSearch', 'true', 'nunes', NULL, 1)
-- ON DUPLICATE KEY UPDATE value = 'true';

-- 4. Desativar busca local (usar busca padrão)
-- UPDATE parameters 
-- SET value = 'false'
-- WHERE `key` = 'monitor.useLocalSearch';

-- Exemplo: Ativar para todas as instâncias (descomentar para usar)
-- INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
-- VALUES ('INSTANCE', 'monitor.useLocalSearch', 'true', 'nunes', NULL, NULL)
-- ON DUPLICATE KEY UPDATE value = 'true';
