# Sistema de Filas para Mensagens Internas

## Visão Geral

Um novo sistema de fila foi implementado para processar mensagens internas (mensagens de grupos de WhatsApp sincronizados com chats internos) de forma assíncrona e resiliente, similarmente ao que já existe para mensagens normais (`messageQueueService`).

## Arquitetura

### Fluxo de Dados

```mermaid
[RemoteWhatsappClient] 
    ↓
[internalMessageQueueService.enqueue()]
    ↓
[InternalMessageProcessingQueue table]
    ↓
[internalMessageQueueService Worker]
    ↓
[internalChatsService.processInternalMessageFromQueue()]
    ↓
[internalChatsService.receiveMessage()]
    ↓
[Mensagem salva e emitida via socket]
```

### Componentes Principais

#### 1. **internalMessageQueueService** (`src/services/internal-message-queue.service.ts`)

- Serviço central de gerenciamento de filas para mensagens internas
- Implementa padrão de singleton
- Responsabilidades:
  - `enqueue()`: Adiciona uma mensagem à fila
  - `startWorker()`: Inicia o processador de fila
  - `stopWorker()`: Para o processador de fila
  - `getQueueStats()`: Retorna estatísticas da fila
  - `cleanOldCompletedItems()`: Limpa itens antigos

#### 2. **InternalMessageProcessingQueue** (Tabela no Banco)

Estrutura de dados para armazenar mensagens em fila:

```prisma
model InternalMessageProcessingQueue {
  id                  String  @id @default(uuid())
  instance            String  
  internalChatId      Int     
  internalMessageId   Int?    
  groupId             String  
  messageData         String  @db.LongText  // JSON da CreateMessageDto
  authorName          String?
  status              InternalMessageProcessingQueueStatus  @default(PENDING)
  retryCount          Int     @default(0)
  maxRetries          Int     @default(3)
  error               String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt
  processingStartedAt DateTime?
  processedAt         DateTime?
  lockedUntil         DateTime?
  lockedBy            String?
}

enum InternalMessageProcessingQueueStatus {
  PENDING
  PROCESSING
  COMPLETED
  FAILED
}
```

#### 3. **RemoteWhatsappClient** (Modificado)

- Agora enfileira mensagens internas ao invés de processar sincronamente
- Método `handleMessageReceived()` atualizado para usar `internalMessageQueueService.enqueue()`

#### 4. **InternalChatsService** (Modificado)

- Novo método: `processInternalMessageFromQueue()`
- Handler de processamento injetado no `internalMessageQueueService`

## Características

### 1. **Processamento Assíncrono**

- Mensagens são enfileiradas imediatamente
- Processamento acontece em background via worker
- Não bloqueia a requisição HTTP

### 2. **Resiliência com Retry**

- Configurável via `maxRetries` (padrão: 3)
- Retry automático com backoff baseado em intervalo
- Rastreamento de tentativas via `retryCount`

### 3. **Controle de Concorrência**

- Máximo de 10 chats processando simultaneamente (`MAX_CONCURRENT_CHATS`)
- Apenas uma mensagem por chat por vez
- Evita race conditions e sobrecarregar o banco

### 4. **Locking Distribuído**

- Sistema de lock implementado com timeout (`LOCK_DURATION_MS`: 30s)
- Workers identificados via `workerId` (PID + timestamp)
- Locks expirados são liberados automaticamente

### 5. **Rastreamento e Logging**

- Cada item da fila possui:
  - Data de criação (`createdAt`)
  - Data de atualização (`updatedAt`)
  - Data/hora do início do processamento (`processingStartedAt`)
  - Data de conclusão (`processedAt`)
  - Mensagens de erro (`error`)

### 6. **Limpeza Automática**

- Método `cleanOldCompletedItems()` remove itens com 7+ dias completos
- Pode ser executado via scheduler (recomendado) ou manualmente

## Uso

### Enfileirar uma Mensagem

```typescript
const queueId = await internalMessageQueueService.enqueue({
  instance: 'instance_name',
  internalChatId: 1,
  groupId: '123456789-1234567890@g.us',
  messageData: createMessageDto,
  authorName: 'João Silva'
});
```

### Iniciar o Worker

No `main.ts`, o worker é iniciado automaticamente:

```typescript
internalMessageQueueService.startWorker();
```

### Obter Estatísticas

```typescript
const stats = await internalMessageQueueService.getQueueStats();
// Resultado: { pending: 5, processing: 2, completed: 150, failed: 0, total: 157 }
```

### Limpar Itens Antigos

```typescript
const deletedCount = await internalMessageQueueService.cleanOldCompletedItems();
```

## Configurações

### Constantes (em `internal-message-queue.service.ts`)

| Constante | Valor Padrão | Descrição |
| --- | --- | --- |
| `PROCESSING_INTERVAL_MS` | 100ms | Frequência do processamento de fila |
| `LOCK_DURATION_MS` | 30s | Duração do lock distribuído |
| `MAX_CONCURRENT_CHATS` | 10 | Máximo de chats processando simultaneamente |

### Configurações na Tabela (por item)

| Campo | Padrão | Descrição |
| --- | --- | --- |
| `status` | PENDING | Estado atual do item |
| `retryCount` | 0 | Número de tentativas já feitas |
| `maxRetries` | 3 | Máximo de tentativas permitidas |

## Monitoramento

### Status de um Item

```typescript
const item = await prismaService.internalMessageProcessingQueue.findUnique({
  where: { id: 'queue-item-id' }
});

console.log(`Status: ${item.status}`);
console.log(`Tentativas: ${item.retryCount}/${item.maxRetries}`);
console.log(`Erro: ${item.error}`);
console.log(`Tempo de processamento: ${item.processedAt - item.processingStartedAt}ms`);
```

### Listar Itens Pendentes

```typescript
const pending = await prismaService.internalMessageProcessingQueue.findMany({
  where: { status: 'PENDING' },
  orderBy: { createdAt: 'asc' }
});
```

### Itens com Falha

```typescript
const failed = await prismaService.internalMessageProcessingQueue.findMany({
  where: { status: 'FAILED' },
  include: { internalChat: true }
});

for (const item of failed) {
  console.log(`Chat: ${item.internalChat?.id}, Erro: ${item.error}`);
}
```

## Tratamento de Erros

### Fluxo de Erro

1. **Execução Falha**: O handler lança uma exceção
2. **Verificação de Tentativas**: Se `retryCount < maxRetries`:
   - Status volta para `PENDING`
   - `retryCount` é incrementado
   - Lock é liberado
   - Mensagem será reprocessada no próximo ciclo
3. **Exceção de Limite**: Se `retryCount >= maxRetries`:
   - Status é definido para `FAILED`
   - Mensagem de erro é armazenada
   - Item é mantido para auditoria

### Debugging

Cada tentativa de processamento gera logs via `ProcessingLogger`:

```log
[InternalMessageQueueService] Lock adquirido. Iniciando processamento
[InternalMessageQueueService] Processando mensagem interna do chat 5, grupo 123456789-1234567890@g.us
[receive-internal-message] Recebendo mensagem de grupo WhatsApp...
[receive-internal-message] Mensagem salva com sucesso
[receive-internal-message] Emitindo evento de mensagem via socket
```

## Comparação com messageQueueService

| Aspecto | messageQueueService | internalMessageQueueService |
| --- | --- | --- |
| Tipo de Mensagem | WhatsApp normais | Grupos de WhatsApp |
| Tabela | `wpp_message_processing_queue` | `internal_message_processing_queue` |
| Handler | `messagesDistributionService.processMessageFromQueue()` | `internalChatsService.processInternalMessageFromQueue()` |
| Processamento | Via `messagesDistributionService.processMessage()` | Via `internalChatsService.receiveMessage()` |
| Tipo de Contato | `WppContact` | Grupo de WhatsApp |
| Rastreamento | Por messageId | Por groupId + messageData (serializado) |

## Integração com Existentes

### RemoteWhatsappClient

```typescript
// Antes:
const savedMsg = await internalChatsService.receiveMessage(groupId, createMessageDto, authorName);

// Depois:
await internalMessageQueueService.enqueue({
  instance: this.instance,
  internalChatId: internalChat.id,
  groupId: groupId,
  messageData: createMessageDto,
  authorName: contactName || authorName
});
```

### InternalChatsService

```typescript
// Antes: receiveMessage era chamada sincronamente
// Depois: receiveMessage é chamada assinc via fila

// Novo handler:
public async processInternalMessageFromQueue(
  _instance: string,
  _internalChatId: number,
  _queueId: string,
  groupId: string,
  messageData: CreateMessageDto,
  authorName?: string | null
): Promise<void> {
  await this.receiveMessage(groupId, messageData, authorName);
}
```

## Testes Recomendados

1. **Teste de Enfileiramento**: Enviar múltiplas mensagens para o mesmo grupo
2. **Teste de Falha**: Simular erro no processamento e verificar retry
3. **Teste de Concorrência**: Enviar mensagens para diversos grupos simultaneamente
4. **Teste de Locking**: Verificar que não há processamento duplicado
5. **Teste de Limpeza**: Executar `cleanOldCompletedItems()` e verificar remoção

## Próximos Passos

1. Monitorar estatísticas em produção
2. Considerar adicionar métricas no dashboard
3. Implementar scheduler para limpeza automática
4. Avaliar necessidade de ajustar `MAX_CONCURRENT_CHATS` baseado em carga
5. Adicionar alertas para taxa alta de falhas
