# Sincronização Local - Documentação

## Visão Geral

Sistema de sincronização automática dos dados do Prisma (banco principal) para as tabelas locais no banco de cada tenant.

## Tabelas Locais

### wpp_contacts
Réplica da tabela de contatos no banco local do tenant.

```sql
CREATE TABLE wpp_contacts (
    id INT NOT NULL,
    instance VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    customer_id INT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY unique_instance_phone (instance, phone)
);
```

### wpp_contact_sectors
Tabela de relacionamento entre contatos e setores.

```sql
CREATE TABLE wpp_contact_sectors (
    contact_id INT NOT NULL,
    sector_id INT NOT NULL,
    PRIMARY KEY (contact_id, sector_id)
);
```

### wpp_chats
Réplica da tabela de chats no banco local do tenant.

```sql
CREATE TABLE wpp_chats (
    id INT NOT NULL,
    instance VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    avatar_url TEXT NULL,
    user_id INT NULL,
    contact_id INT NOT NULL,
    sector_id INT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME NULL,
    finished_by INT NULL,
    result_id INT NULL,
    is_finished TINYINT(1) NOT NULL DEFAULT 0,
    is_schedule TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id)
);
```

## Como Usar

### 1. Sincronização Manual

#### Sincronizar todas as instâncias:
```bash
npm run sync:local
```

#### Sincronizar uma instância específica:
```bash
npm run sync:local:instance <nome-da-instancia>
```

Exemplo:
```bash
npm run sync:local:instance exatron
```

### 2. Sincronização Automática

As tabelas são sincronizadas automaticamente sempre que:
- Um contato é criado/atualizado/deletado
- Um setor é adicionado/removido de um contato
- Um chat é criado/finalizado/transferido

### 3. Rotina Programada (Cron)

Para executar sincronização periódica, adicione ao seu cron:

```javascript
import cron from 'node-cron';
import { runLocalSyncRoutine } from './routines/local-sync.routine';

// Executar a cada 6 horas
cron.schedule('0 */6 * * *', async () => {
    try {
        await runLocalSyncRoutine();
    } catch (error) {
        console.error('Erro na sincronização automática:', error);
    }
});
```

## Serviços

### LocalSyncService

Serviço principal de sincronização.

**Métodos públicos:**

- `syncInstance(instance: string)`: Sincroniza uma instância específica
- `syncAllInstances()`: Sincroniza todas as instâncias

**Métodos privados:**

- `ensureTablesExist(instance)`: Cria as tabelas se não existirem
- `syncContacts(instance)`: Sincroniza contatos
- `syncContactSectors(instance)`: Sincroniza setores de contatos
- `syncChats(instance)`: Sincroniza chats

## Performance

- **Batch processing**: Processa dados em lotes de 100-500 registros
- **Upsert queries**: Usa `INSERT ... ON DUPLICATE KEY UPDATE` para evitar duplicatas
- **Logs detalhados**: Fornece feedback sobre o progresso da sincronização

## Logs

Exemplo de saída:

```
[LocalSync] ====== Iniciando sincronização para: exatron ======
[LocalSync] Verificando tabelas no banco do tenant: exatron
[LocalSync] Tabela wpp_contacts verificada/criada
[LocalSync] Tabela wpp_contact_sectors verificada/criada
[LocalSync] Tabela wpp_chats verificada/criada
[LocalSync] Sincronizando contatos para: exatron
[LocalSync] 1523 contatos sincronizados
[LocalSync] Sincronizando setores de contatos para: exatron
[LocalSync] 847 setores de contatos sincronizados
[LocalSync] Sincronizando chats para: exatron
[LocalSync] 342 chats sincronizados
[LocalSync] ====== Sincronização concluída para: exatron ======
[LocalSync] Resumo: 1523 contatos, 847 setores, 342 chats
```

## Quando Executar

### Primeira vez / Setup inicial
Execute a sincronização manual completa:
```bash
npm run sync:local
```

### Após migrações ou mudanças estruturais
Se houver alterações no schema das tabelas, execute novamente.

### Recuperação de desastre
Se o banco local estiver inconsistente ou corrompido.

### Manutenção preventiva
Configure um cron job para executar semanalmente.

## Troubleshooting

### Erro: "Table doesn't exist"
Execute a sincronização manual - ela criará as tabelas automaticamente.

### Dados desatualizados
Execute a sincronização manual para forçar atualização.

### Performance lenta
- Verifique índices nas tabelas
- Considere executar fora do horário de pico
- Ajuste o `batchSize` no código se necessário

## Compatibilidade

✅ MySQL 5.5+
✅ MariaDB 10.0+
