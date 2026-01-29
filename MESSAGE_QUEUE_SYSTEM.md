# Sistema de Fila Persistente de Processamento de Mensagens

## Visão Geral

Sistema robusto de processamento de mensagens WhatsApp que garante **zero perda de mensagens** mesmo em caso de queda do servidor, utilizando uma fila persistente no banco de dados.

## Características Principais

### ✅ Garantias

- **Persistência**: Todas as mensagens são armazenadas no banco antes do processamento
- **Zero Perda**: Em caso de queda, mensagens pendentes são retomadas automaticamente
- **Sem Duplicatas**: Sistema de locks por contato impede criação de atendimentos duplicados
- **Retry Automático**: Até 3 tentativas automáticas em caso de falha
- **Processamento Ordenado**: Mensagens do mesmo contato são processadas sequencialmente

### 🔒 Controle de Concorrência

- Máximo de 10 contatos diferentes processando simultaneamente
- Apenas uma mensagem por contato é processada por vez
- Locks com expiração automática (30 segundos) para evitar travamentos

## Arquitetura

```
┌─────────────────┐
│  Nova Mensagem  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│  enqueueMessage()       │
│  Salva no BD (PENDING)  │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  Worker (100ms)         │
│  - Busca PENDING        │
│  - Agrupa por contato   │
│  - Processa até 10      │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  acquireLock()          │
│  Status → PROCESSING    │
│  lockedBy = workerId    │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│  processMessageFromQueue│
│  Executa lógica real    │
└────────┬────────────────┘
         │
    ┌────┴────┐
    │         │
  Sucesso   Erro
    │         │
    ▼         ▼
COMPLETED   RETRY/FAILED
```

## Modelo de Dados

```prisma
model WppMessageProcessingQueue {
  id                  String   @id @default(uuid())
  instance            String
  clientId            Int
  messageId           Int
  contactPhone        String
  contactName         String?
  status              Enum     // PENDING|PROCESSING|COMPLETED|FAILED
  retryCount          Int      @default(0)
  maxRetries          Int      @default(3)
  error               String?
  createdAt           DateTime @default(now())
  processingStartedAt DateTime?
  processedAt         DateTime?
  lockedUntil         DateTime?
  lockedBy            String?
}
```

## Como Usar

### 1. Executar Migração

```bash
npx prisma migrate dev --name add-message-processing-queue
```

### 2. Inicializar Worker (já configurado no main.ts)

```typescript
import messageQueueService from "./services/message-queue.service";

// No startup da aplicação
messageQueueService.startWorker();
```

### 3. Enfileirar Mensagens

**ANTES (processamento direto - pode perder mensagens):**
```typescript
await messagesDistributionService.processMessage(instance, clientId, message);
```

**DEPOIS (fila persistente - seguro):**
```typescript
// Automático: processMessage agora enfileira por padrão
await messagesDistributionService.processMessage(instance, clientId, message);

// Ou explicitamente:
await messagesDistributionService.enqueueMessage(instance, clientId, message);
```

### 4. Monitorar Fila

```bash
# Verificar estatísticas
GET /message-queue/stats

# Resposta:
{
  "pending": 150,
  "processing": 10,
  "completed": 5000,
  "failed": 5,
  "total": 5165
}
```

### 5. Limpar Itens Antigos

```bash
POST /message-queue/clean
```

Remove itens COMPLETED com mais de 7 dias.

## Processamento em Massa

### ❌ ANTES (Problema)

```typescript
// Recuperar mensagens antigas
const messages = await getOldMessages(); // 1000 mensagens

// Processar todas de uma vez
await Promise.all(
  messages.map(msg => 
    messagesDistributionService.processMessage(instance, clientId, msg)
  )
);
// ⚠️ Cria múltiplos atendimentos para o mesmo contato!
```

### ✅ AGORA (Solução)

```typescript
// Recuperar mensagens antigas
const messages = await getOldMessages(); // 1000 mensagens

// Enfileirar todas
for (const msg of messages) {
  await messagesDistributionService.enqueueMessage(instance, clientId, msg);
  // ✅ Salva no banco, não processa ainda
}

// Worker processa automaticamente:
// - Respeitando ordem
// - Sem duplicatas
// - Um contato por vez
// - Máximo 10 simultâneos
```

## Fluxo de Retry

```
Tentativa 1 → ERRO → status: PENDING, retryCount: 1
    ↓ (worker tenta novamente)
Tentativa 2 → ERRO → status: PENDING, retryCount: 2
    ↓ (worker tenta novamente)
Tentativa 3 → ERRO → status: FAILED (excedeu max retries)
```

## Recuperação de Falhas

### Cenário: Servidor Cai Durante Processamento

```
1. Worker estava processando 10 mensagens
2. Servidor cai inesperadamente
3. Status no BD: PROCESSING, lockedUntil: 2026-01-28T12:30:00

--- SERVIDOR REINICIA ---

4. Worker inicia e executa releaseExpiredLocks()
5. Detecta locks expirados (lockedUntil < now)
6. Atualiza para: status: PENDING, lockedUntil: null
7. Mensagens voltam para a fila
8. Worker processa normalmente
```

### Cenário: Mensagem Falha 3 Vezes

```
1. Mensagem entra na fila: status = PENDING
2. Worker processa → ERRO
3. status = PENDING, retryCount = 1
4. Worker processa → ERRO
5. status = PENDING, retryCount = 2
6. Worker processa → ERRO
7. status = FAILED (retryCount >= maxRetries)
8. Mensagem NÃO é mais processada
9. Admin analisa tabela wpp_message_processing_queue
10. Admin corrige problema e volta manualmente para PENDING (se necessário)
```

## Configurações (message-queue.service.ts)

```typescript
private readonly PROCESSING_INTERVAL_MS = 100;      // Verifica fila a cada 100ms
private readonly LOCK_DURATION_MS = 30000;          // Lock expira em 30s
private readonly MAX_CONCURRENT_CONTACTS = 10;      // Máx. contatos simultâneos
private readonly maxRetries = 3;                    // Tentativas por mensagem
```

## Logs e Debug

O sistema gera logs detalhados via `ProcessingLogger`:

```
[MessageQueue] Mensagem 12345 enfileirada. Queue ID: abc-123-def
[MessageQueue] Tentando adquirir lock para processar item da fila
[MessageQueue] Lock adquirido. Iniciando processamento
[MessageQueue] Processando mensagem 12345 do contato 5511999999999
[MessageQueue] Mensagem processada com sucesso
```

## Manutenção

### Consultas Úteis

```sql
-- Ver mensagens pendentes
SELECT * FROM wpp_message_processing_queue 
WHERE status = 'PENDING' 
ORDER BY created_at;

-- Ver mensagens falhadas
SELECT * FROM wpp_message_processing_queue 
WHERE status = 'FAILED';

-- Ver locks ativos
SELECT * FROM wpp_message_processing_queue 
WHERE status = 'PROCESSING' 
AND locked_until > NOW();

-- Forçar reprocessamento de uma mensagem falhada
UPDATE wpp_message_processing_queue 
SET status = 'PENDING', retry_count = 0, error = NULL
WHERE id = 'abc-123-def';
```

### Limpeza Automática

O sistema automaticamente remove itens COMPLETED com mais de 7 dias via:

```typescript
await messageQueueService.cleanOldCompletedItems();
```

Configure um cron job para executar periodicamente:

```typescript
// Em main.ts ou worker separado
setInterval(() => {
  messageQueueService.cleanOldCompletedItems();
}, 24 * 60 * 60 * 1000); // 1x por dia
```

## Monitoramento

### Métricas Importantes

1. **pending**: Mensagens aguardando processamento
   - ⚠️ Se crescer constantemente: aumentar workers ou velocidade
   
2. **processing**: Mensagens sendo processadas agora
   - Normal: até MAX_CONCURRENT_CONTACTS (10)
   - ⚠️ Se ficar travado: verificar locks expirados
   
3. **failed**: Mensagens que falharam após 3 tentativas
   - ⚠️ Investigar erros e corrigir causa raiz

### Dashboard Simples

```typescript
// Endpoint de health check
app.get('/health/queue', async (req, res) => {
  const stats = await messageQueueService.getQueueStats();
  
  const health = {
    status: stats.pending < 1000 ? 'healthy' : 'warning',
    ...stats,
    timestamp: new Date()
  };
  
  res.json(health);
});
```

## Migração do Sistema Antigo

### Passo 1: Executar migração Prisma
```bash
npx prisma migrate dev
```

### Passo 2: Deploy (worker inicia automaticamente)
```bash
npm run build
npm run start
```

### Passo 3: Código já usa fila por padrão
Não precisa alterar código existente! O método `processMessage` agora enfileira automaticamente.

### Passo 4: Monitorar primeiras horas
```bash
# Verificar se mensagens estão sendo processadas
curl http://localhost:8005/message-queue/stats
```

## Vantagens vs Sistema Anterior

| Aspecto | Antes | Agora |
|---------|-------|-------|
| Perda de mensagens | ⚠️ Possível (em memória) | ✅ Impossível (persistente) |
| Atendimentos duplicados | ⚠️ Possível (race condition) | ✅ Impossível (lock BD) |
| Recuperação de falhas | ❌ Manual | ✅ Automática |
| Retry | ❌ Não | ✅ Sim (3x) |
| Monitoramento | ❌ Difícil | ✅ API + BD |
| Processamento massa | ⚠️ Problemático | ✅ Seguro |

## Troubleshooting

### Problema: Mensagens não são processadas

**Causa**: Worker não está rodando
```bash
# Verificar logs
grep "Message queue worker started" logs/app.log
```

**Solução**: Reiniciar aplicação

---

### Problema: Muitas mensagens FAILED

**Causa**: Erro recorrente no processamento
```sql
-- Ver erros mais comuns
SELECT error, COUNT(*) as count 
FROM wpp_message_processing_queue 
WHERE status = 'FAILED' 
GROUP BY error 
ORDER BY count DESC;
```

**Solução**: Corrigir causa raiz e reprocessar

---

### Problema: Fila muito grande (pending > 10000)

**Causa**: Processamento não acompanha entrada
```typescript
// Aumentar workers simultâneos
private readonly MAX_CONCURRENT_CONTACTS = 20; // era 10
```

**Solução**: Escalar horizontalmente (múltiplas instâncias)

## Conclusão

O sistema de fila persistente garante **processamento seguro e confiável** de mensagens WhatsApp, eliminando perda de dados e duplicação de atendimentos, mesmo em cenários de alto volume ou falhas de sistema.
