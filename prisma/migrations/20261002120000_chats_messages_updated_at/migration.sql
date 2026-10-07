-- Filtro BI "updatedFrom" em /conversations e /messages/export.
--
-- updated_at é mantido pelo próprio banco (DEFAULT + ON UPDATE), então cobre também
-- alterações feitas fora do Prisma. Linhas existentes ficam NULL ("sem alteração desde
-- a migração"): o filtro updated_at >= ? as ignora e nenhum backfill é necessário.
--
-- Cada ALTER declara ALGORITHM/LOCK: se o MySQL não puder executar sem bloquear
-- escritas, ele recusa o comando em vez de copiar a tabela. O lock_wait_timeout curto
-- evita que um ALTER esperando metadata lock enfileire as consultas do sistema.

SET SESSION lock_wait_timeout = 5;

-- 1) Coluna nula: existentes ficam NULL (instantâneo, só metadados).
ALTER TABLE `chats` ADD COLUMN `updated_at` DATETIME(3) NULL, ALGORITHM=INSTANT;
ALTER TABLE `messages` ADD COLUMN `updated_at` DATETIME(3) NULL, ALGORITHM=INSTANT;

-- 2) Default e ON UPDATE valem só para inserções e alterações a partir daqui.
ALTER TABLE `chats`
    MODIFY COLUMN `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE `messages`
    MODIFY COLUMN `updated_at` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    ALGORITHM=INPLACE, LOCK=NONE;

-- 3) Índices da paginação incremental (o id da PK entra implicitamente no índice).
ALTER TABLE `chats`
    ADD INDEX `chats_instance_updated_at_idx` (`instance`, `updated_at`),
    ALGORITHM=INPLACE, LOCK=NONE;
ALTER TABLE `messages`
    ADD INDEX `messages_instance_updated_at_idx` (`instance`, `updated_at`),
    ALGORITHM=INPLACE, LOCK=NONE;
