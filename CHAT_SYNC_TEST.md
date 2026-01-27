# Chat Synchronization Test Guide

## Objetivo
Verificar se a sincronização de chats com o banco local está funcionando corretamente ao criar um novo atendimento.

## Passos para Testar

### 1. Verificar Logs
Ao iniciar um atendimento via POST `/api/whatsapp/chats`, você verá:
- Se a sincronização foi chamada: `[syncChatToLocal] Chat {id} sincronizado com sucesso na instância develop`
- Se houver erro: `[syncChatToLocal] Erro ao sincronizar chat: {erro}`

### 2. Verificar Banco de Dados Local
Após criar um chat, execute a query abaixo no banco de dados do tenant (ex: develop):

```sql
SELECT id, original_id, contact_id, user_id, is_finished, started_at 
FROM wpp_chats 
ORDER BY id DESC 
LIMIT 1;
```

Você deve ver o chat mais recentemente criado.

### 3. Verificar Correlação Prisma vs Local
- **original_id** deve ser igual ao **id** (ambos do chat criado no Prisma)
- **contact_id** deve corresponder ao contactId enviado no request
- **user_id** deve corresponder ao userId da sessão

### 4. Possíveis Problemas

#### Problema: Chat criado no Prisma mas não no banco local
**Solução**: Verifique se:
1. A tabela `wpp_chats` existe no banco do tenant
2. A coluna `original_id` existe e tem UNIQUE constraint
3. Há erros nos logs do serviço (procure por `[syncChatToLocal] Erro`)

#### Problema: Erro de constraint UNIQUE em original_id
**Solução**: Execute migration para resetar a tabela:
```bash
npm run sync:local:instance develop
```

## Mudanças Recentes

### Melhorias Implementadas:
1. ✅ Adicionado `original_id INT NOT NULL UNIQUE` à tabela `wpp_chats`
2. ✅ Sincronização agora acontece IMEDIATAMENTE após criar o chat
3. ✅ Erro na sincronização agora é propagado (não é silenciado)
4. ✅ Logging adicionado para debug

### Fluxo Correto:
```
1. POST /api/whatsapp/chats (contactId)
   ↓
2. chatsService.startChatByContactId()
   ↓
3. prismaService.wppChat.create() → cria no Prisma
   ↓
4. syncChatToLocal() → sincroniza com banco local
   ↓
5. Retorna newChat ao controller
   ↓
6. Controller retorna 200 com dados do chat
```

## Verificar Sincronização Real-time

Após criar um chat, verifique em tempo real:

```sql
-- Terminal 1: Ver dados no Prisma (via API)
GET /api/whatsapp/chats/{chatId}

-- Terminal 2: Ver dados no banco local
SELECT * FROM wpp_chats WHERE original_id = {chatId};
```

Os dados devem ser idênticos (com conversão de tipos conforme necessário).
