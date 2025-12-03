# Sistema de Fila de Mensagens com Persistência

## 📋 Visão Geral

Sistema robusto de gerenciamento de filas de mensagens com persistência em banco de dados, garantindo que **nenhuma mensagem seja perdida** em caso de quedas do sistema.

## 🎯 Funcionalidades

### ✅ Persistência em Banco de Dados
- Todas as mensagens são salvas no banco antes de serem processadas
- Estados rastreados: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`
- Recuperação automática após quedas do sistema

### ✅ Processamento Sequencial
- Uma mensagem por vez por chat
- Respeita ordem de chegada (FIFO)
- Suporte a priorização (mensagens prioritárias vão para o início da fila)

### ✅ Sistema de Retries
- Tentativas automáticas em caso de falha
- Configurável por mensagem (padrão: 3 tentativas)
- Rastreamento de erros

### ✅ Recuperação Automática
- Detecta mensagens travadas em `PROCESSING`
- Reseta automaticamente para `PENDING` após 1 hora
- Recupera mensagens pendentes ao reiniciar

### ✅ Limpeza Automática
- Remove mensagens antigas automaticamente
- Padrão: remove mensagens processadas após 7 dias
- Execução agendada a cada 6 horas

## 🗄️ Modelo de Dados

```prisma
model MessageQueueItem {
  id                  String             @id @default(uuid())
  instance            String
  chatId              String
  clientId            Int
  status              MessageQueueStatus @default(PENDING)
  priority            Int                @default(0)
  payload             Json               // Dados da mensagem
  isGroup             Boolean            @default(false)
  retryCount          Int                @default(0)
  maxRetries          Int                @default(3)
  error               String?            @db.Text
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt
  processingStartedAt DateTime?
  processedAt         DateTime?
}

enum MessageQueueStatus {
  PENDING     // Aguardando processamento
  PROCESSING  // Sendo processada no momento
  COMPLETED   // Enviada com sucesso
  FAILED      // Falhou após todas as tentativas
  CANCELLED   // Cancelada manualmente
}
```

## 📊 Fluxo de Processamento

```
┌─────────────────┐
│  Nova Mensagem  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Salva no Banco  │
│ (status=PENDING)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Adiciona à Fila │
│   (em memória)  │
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│ Aguarda vez na fila │
└─────────┬───────────┘
          │
          ▼
┌──────────────────────┐
│ Atualiza: PROCESSING │
└──────────┬───────────┘
           │
           ▼
    ┌──────────────┐
    │ Envia Mensagem│
    └──────┬────────┘
           │
      ┌────┴────┐
      │         │
   SUCESSO   ERRO
      │         │
      │    ┌────┴─────┐
      │    │ Retry <  │
      │    │ MaxRetry?│
      │    └────┬─────┘
      │         │
      │    ┌────┴────┐
      │   SIM      NÃO
      │    │         │
      │    ▼         ▼
      │ PENDING  FAILED
      │
      ▼
  COMPLETED
```

## 🚀 Uso

### Inicialização

```typescript
// Automático no handleReady do WWEBJSWhatsappClient
await this.messageQueue.initialize(this.instance, this.id);
```

### Envio de Mensagem

```typescript
// Automático ao chamar sendMessage
await client.sendMessage({
  to: "5511999999999",
  text: "Olá!"
});
// A mensagem é automaticamente enfileirada e persistida
```

### Com Prioridade

```typescript
await this.messageQueue.enqueue(
  instance,
  clientId,
  chatId,
  messageId,
  payload,
  isGroup,
  executor,
  { priority: 10, maxRetries: 5 } // Alta prioridade, 5 tentativas
);
```

### Estatísticas da Fila

```typescript
const stats = await messageQueue.getStats(instance, clientId);
console.log(stats);
// { pending: 5, processing: 1, completed: 100, failed: 2 }
```

### Limpeza Manual

```typescript
// Remove mensagens > 7 dias
await messageQueue.cleanOldMessages(instance, 7);

// Cancela todas as mensagens de um chat
await messageQueue.clearQueue(instance, chatId);
```

## ⚙️ Configuração

### Limpeza Automática

```typescript
// Agendada automaticamente no handleReady
// Intervalo: 6 horas
// Retenção: 7 dias
scheduleMessageQueueCleanup(instance, 6, 7);
```

### Personalizar Retries

```typescript
const payload = { /* ... */ };
await messageQueue.enqueue(
  instance,
  clientId, 
  chatId,
  messageId,
  payload,
  isGroup,
  executor,
  { maxRetries: 5 } // 5 tentativas em vez de 3
);
```

## 🔍 Monitoramento

### Mensagens Travadas

O sistema detecta automaticamente mensagens travadas em `PROCESSING` por mais de 1 hora e as reseta para `PENDING`:

```typescript
// Executado automaticamente a cada 6 horas
// Logs:
// [CleanMessageQueue] Encontradas 2 mensagens travadas em PROCESSING. Resetando...
// [CleanMessageQueue] 2 mensagens resetadas para PENDING
```

### Logs Detalhados

```typescript
Logger.debug('[MessageQueue] Mensagem abc123 persistida no banco (chat: 5511999999999)');
Logger.debug('[MessageQueue] Mensagem abc123 adicionada à fila do chat 5511999999999');
Logger.debug('[MessageQueue] Processando mensagem abc123 do chat 5511999999999');
Logger.debug('[MessageQueue] Mensagem abc123 processada com sucesso');
```

## 🛡️ Proteções

### Contra Perda de Mensagens
- ✅ Persistência antes do processamento
- ✅ Recuperação automática após quedas
- ✅ Sistema de retries
- ✅ Rastreamento de erros

### Contra Mensagens Duplicadas
- ✅ ID único (UUID) por mensagem
- ✅ Verificação de status antes de processar
- ✅ Atomicidade nas atualizações do banco

### Contra Sobrecarga
- ✅ Processamento sequencial por chat
- ✅ Delays entre mensagens (0.5s-2s)
- ✅ Limpeza automática de mensagens antigas

## 📈 Performance

### Otimizações
- Índices no banco: `(instance, chatId, status)`, `(status, createdAt)`, `(clientId, status)`
- Fila em memória para acesso rápido
- Processamento assíncrono não-bloqueante

### Capacidade
- ✅ Múltiplos chats processados em paralelo
- ✅ Um chat por vez (evita race conditions)
- ✅ Priorização flexível

## 🔧 Manutenção

### Migração do Banco

```bash
# Criar migration
npx prisma migrate dev --name add_message_queue

# Aplicar em produção
npx prisma migrate deploy
```

### Consultas Úteis

```sql
-- Mensagens pendentes
SELECT * FROM message_queue_items WHERE status = 'PENDING';

-- Mensagens falhadas
SELECT * FROM message_queue_items WHERE status = 'FAILED' ORDER BY updated_at DESC;

-- Estatísticas por status
SELECT status, COUNT(*) FROM message_queue_items GROUP BY status;

-- Mensagens antigas a serem limpas
SELECT COUNT(*) FROM message_queue_items 
WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED') 
AND processed_at < DATE_SUB(NOW(), INTERVAL 7 DAY);
```

## 🎓 Boas Práticas

1. **Sempre use a fila para enviar mensagens** - Não envie diretamente pelo cliente
2. **Monitore mensagens falhadas** - Configure alertas para `status=FAILED`
3. **Ajuste a retenção conforme necessário** - Mais ou menos que 7 dias
4. **Use prioridades com moderação** - Não abuse de mensagens de alta prioridade
5. **Verifique logs regularmente** - Especialmente mensagens travadas

## 🚨 Solução de Problemas

### Mensagens não estão sendo enviadas

```typescript
// Verificar estatísticas
const stats = await messageQueue.getStats(instance, clientId);
console.log(stats);

// Verificar mensagens travadas
SELECT * FROM message_queue_items 
WHERE status = 'PROCESSING' 
AND processing_started_at < DATE_SUB(NOW(), INTERVAL 1 HOUR);
```

### Fila está crescendo muito

```typescript
// Reduzir tempo de retenção
await messageQueue.cleanOldMessages(instance, 3); // 3 dias em vez de 7

// Cancelar mensagens antigas pendentes
await prisma.messageQueueItem.updateMany({
  where: {
    status: 'PENDING',
    createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // > 24h
  },
  data: { status: 'CANCELLED' }
});
```

### Alto número de falhas

```typescript
// Investigar erros comuns
SELECT error, COUNT(*) as count 
FROM message_queue_items 
WHERE status = 'FAILED' 
GROUP BY error 
ORDER BY count DESC;
```

## 📚 Referências

- **MessageQueue**: `src/utils/message-queue.ts`
- **Schema**: `prisma/schema.prisma`
- **Rotina de Limpeza**: `src/routines/clean-message-queue.routine.ts`
- **Cliente**: `src/whatsapp-client/wwebjs-whatsapp-client.ts`
