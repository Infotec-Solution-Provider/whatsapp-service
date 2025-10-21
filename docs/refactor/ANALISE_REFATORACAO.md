# 📊 Análise Completa e Plano de Refatoração - WhatsApp Service

**Data da Análise:** 15 de Outubro de 2025  
**Arquivos Analisados:** 79 arquivos TypeScript  
**Linhas de Código:** ~2.974 linhas (arquivos principais)  
**Banco de Dados:** MySQL com Prisma ORM  

---

## 📋 Índice

1. [Resumo Executivo](#resumo-executivo)
2. [Problemas Críticos Identificados](#problemas-criticos)
3. [Problemas de Arquitetura](#problemas-de-arquitetura)
4. [Problemas de Código](#problemas-de-codigo)
5. [Problemas de Performance](#problemas-de-performance)
6. [Problemas de Segurança](#problemas-de-seguranca)
7. [Análise do Schema do Banco](#analise-do-banco)
8. [Plano de Refatoração](#plano-de-refatoracao)
9. [Arquitetura Proposta](#arquitetura-proposta)
10. [Estimativas e Prioridades](#estimativas)

---

## 🎯 Resumo Executivo

### ✅ Pontos Positivos
- Uso de TypeScript com configurações strict ativadas
- Prisma ORM bem configurado
- Express com async-errors
- Separação básica entre controllers e services
- Configuração de prettier e editorconfig

### ❌ Problemas Principais
1. **God Classes**: `WhatsappService` com 847 linhas e múltiplas responsabilidades
2. **Acoplamento Alto**: Services dependem diretamente uns dos outros
3. **Falta de Injeção de Dependência**: Uso de singletons e imports diretos
4. **Código Duplicado**: Lógica repetida em vários lugares
5. **Falta de Testes**: Não há testes unitários ou de integração
6. **Falta de Documentação**: APIs não documentadas
7. **Tipagem Fraca**: Uso excessivo de `any` (50+ ocorrências)
8. **Arquitetura Inconsistente**: Mistura de padrões e responsabilidades

---

## 🔴 Problemas Críticos Identificados

### 1. **God Class - WhatsappService (847 linhas)**

**Arquivo:** `src/services/whatsapp.service.ts`

**Problemas:**
```typescript
class WhatsappService {
    private readonly clients = new Map<number, WhatsappClient>();
    
    // 40+ métodos públicos com responsabilidades diferentes:
    // - Gerenciamento de clientes
    // - Envio de mensagens
    // - Encaminhamento
    // - Templates
    // - Grupos
    // - Validação de telefone
    // - Resposta automática
    // - Verificação de janela de conversa
}
```

**Impacto:**
- 🔴 **CRÍTICO** - Impossível de testar
- 🔴 **CRÍTICO** - Viola SRP (Single Responsibility Principle)
- 🔴 **CRÍTICO** - Alto acoplamento
- 🟡 **ALTO** - Difícil manutenção

**Solução:**
Dividir em múltiplos services especializados:
- `WhatsappClientManager` - Gerenciamento de clientes
- `MessageSender` - Envio de mensagens
- `MessageForwarder` - Encaminhamento
- `TemplateService` - Templates
- `ConversationWindowChecker` - Validações
- `AutoReplyService` - Respostas automáticas

---

### 2. **Ausência de Injeção de Dependência**

**Problema:**
```typescript
// ❌ Acoplamento forte via imports diretos
import whatsappService from "./whatsapp.service";
import messagesService from "./messages.service";
import chatsService from "./chats.service";

// Todos os services são singletons
export default new WhatsappService();
```

**Impacto:**
- 🔴 **CRÍTICO** - Impossível mockar em testes
- 🔴 **CRÍTICO** - Dependências circulares
- 🟡 **ALTO** - Dificulta refatoração

**Solução:**
Implementar Dependency Injection com `tsyringe`:
```typescript
// ✅ Solução proposta
import { injectable, inject } from "tsyringe";

@injectable()
class WhatsappService {
    constructor(
        @inject("IMessageRepository") private messageRepo: IMessageRepository,
        @inject("IWhatsappClient") private client: IWhatsappClient
    ) {}
}
```

---

### 3. **Uso Excessivo de `any` (50+ ocorrências)**

**Exemplos Encontrados:**
```typescript
// ❌ Tipagem fraca
public async getTemplates(): Promise<any> { }
const reqBody: any = { };
let msg: any = {};
} catch (err: any) { }
```

**Impacto:**
- 🟡 **ALTO** - Perda dos benefícios do TypeScript
- 🟡 **ALTO** - Bugs difíceis de detectar
- 🟢 **MÉDIO** - Autocompletion quebrado

**Solução:**
Criar interfaces e tipos adequados:
```typescript
// ✅ Solução
interface WhatsappTemplate {
    id: string;
    name: string;
    language: string;
    components: TemplateComponent[];
}

public async getTemplates(): Promise<WhatsappTemplate[]> { }
```

---

### 4. **Falta de Tratamento de Erros Consistente**

**Problema:**
```typescript
// Mistura de estratégias de erro
try {
    // código
} catch (err: any) {
    console.error(err); // ❌ Console direto
    throw new BadRequestError("Erro", err); // ❌ Perde contexto
}

// Em outro lugar:
} catch (error) {
    Logger.error("Erro", error); // ❌ Inconsistente
    return null; // ❌ Silencia erro
}
```

**Impacto:**
- 🟡 **ALTO** - Dificulta debugging
- 🟡 **ALTO** - Logs inconsistentes
- 🟢 **MÉDIO** - Experiência ruim para usuário

**Solução:**
Criar camada de tratamento de erros:
```typescript
// ✅ Error Handler centralizado
class ApplicationError extends Error {
    constructor(
        public statusCode: number,
        public message: string,
        public context?: any
    ) {
        super(message);
    }
}

// Middleware de erro
app.use((err, req, res, next) => {
    Logger.error(err.message, { 
        context: err.context,
        stack: err.stack 
    });
    
    res.status(err.statusCode || 500).json({
        error: err.message
    });
});
```

---

### 5. **Lógica de Negócio nos Controllers**

**Problema:**
```typescript
// ❌ messagesController tem lógica de negócio
private async sendMessage(req: Request, res: Response) {
    const { to, ...data } = req.body;
    const file = req.file;
    
    if (file) {
        data.file = file; // ❌ Manipulação de dados
    }
    
    // Deveria apenas delegar para service
}
```

**Impacto:**
- 🟡 **ALTO** - Viola separação de camadas
- 🟢 **MÉDIO** - Dificulta reutilização

**Solução:**
Controllers magros, apenas validação e delegação:
```typescript
// ✅ Controller limpo
private async sendMessage(req: Request, res: Response) {
    const result = await this.messageService.sendMessage(
        req.session,
        req.body,
        req.file
    );
    
    res.status(201).json(result);
}
```

---

### 6. **Services Gigantes e Acoplados**

**Problema:**
```typescript
// ChatsService - 649 linhas
// MessagesDistributionService - 723 linhas
// MessageForwardingService - 348 linhas

// Todos dependem uns dos outros:
import chatsService from "./chats.service";
import messagesService from "./messages.service";
import whatsappService from "./whatsapp.service";
import socketService from "./socket.service";
import messagesDistributionService from "./messages-distribution.service";
```

**Impacto:**
- 🔴 **CRÍTICO** - Dependências circulares
- 🟡 **ALTO** - Difícil de testar
- 🟡 **ALTO** - Mudanças têm efeito cascata

---

### 7. **Bots com Estado Mutável**

**Problema:**
```typescript
// ❌ Estado compartilhado em memória
class ChooseSectorBot {
    private readonly running: { step: number; chatId: number }[] = [];
    private chatState = new Map<string, { operadores: User[]; setor: any }>();
    
    // Se o servidor reiniciar, perde o estado!
}
```

**Impacto:**
- 🔴 **CRÍTICO** - Perde estado em reinício
- 🔴 **CRÍTICO** - Não escala horizontalmente
- 🟡 **ALTO** - Bugs difíceis de reproduzir

**Solução:**
Armazenar estado no banco:
```typescript
// ✅ Estado persistente
interface BotSession {
    chatId: number;
    step: number;
    context: Record<string, any>;
    createdAt: Date;
    updatedAt: Date;
}

// Criar tabela bot_sessions no Prisma
```

---

### 8. **Falta de Validação de Entrada**

**Problema:**
```typescript
// ❌ Sem validação adequada
private async sendMessage(req: Request, res: Response) {
    const { to, ...data } = req.body; // Confia no body direto
    // ...
}
```

**Impacto:**
- 🔴 **CRÍTICO** - Vulnerabilidade de segurança
- 🟡 **ALTO** - Dados inválidos no banco
- 🟡 **ALTO** - Mensagens de erro ruins

**Solução:**
Usar validadores como `zod` ou `class-validator`:
```typescript
// ✅ Validação com Zod
import { z } from "zod";

const SendMessageSchema = z.object({
    to: z.string().min(10).max(15),
    text: z.string().min(1).max(4096).optional(),
    chatId: z.number().int().positive().optional(),
    contactId: z.number().int().positive(),
});

// No controller:
const data = SendMessageSchema.parse(req.body);
```

---

### 9. **Queries N+1 no Banco**

**Problema:**
```typescript
// ❌ N+1 Query Problem
for (const foundChat of foundChats) {
    const customer = customers.find(c => c.CODIGO === contact.customerId);
    // Loop para cada chat
}

// Em outro lugar:
for (const client of clients) {
    // Query dentro de loop
    const sectors = await prismaService.wppSector.findMany({
        where: { wppInstanceId: client.id }
    });
}
```

**Impacto:**
- 🟡 **ALTO** - Performance ruim
- 🟡 **ALTO** - Sobrecarga no banco
- 🟢 **MÉDIO** - Lentidão em produção

**Solução:**
```typescript
// ✅ Eager loading
const chats = await prismaService.wppChat.findMany({
    include: {
        contact: true,
        sector: {
            include: {
                WppInstance: true
            }
        }
    }
});
```

---

### 10. **Falta de Índices no Banco**

**Análise do Schema:**
```prisma
// ✅ Bons índices existentes:
@@index([isActive])
@@index([customerId, instance])
@@index([from, to, chatId])

// ❌ Índices faltando:
model WppMessage {
    sentAt DateTime @map("sent_at")
    // ❌ Falta índice em sentAt (usado em filtros de data)
    
    status WppMessageStatus
    // ❌ Falta índice em status (usado em queries)
}

model WppChat {
    isFinished Boolean @default(false)
    // ❌ Falta índice composto [instance, isFinished]
}
```

**Impacto:**
- 🟡 **ALTO** - Queries lentas
- 🟡 **ALTO** - Full table scans

**Solução:**
Adicionar índices:
```prisma
model WppMessage {
    @@index([sentAt])
    @@index([status])
    @@index([instance, sentAt])
}

model WppChat {
    @@index([instance, isFinished])
    @@index([instance, sectorId, isFinished])
}
```

---

## 🏗️ Problemas de Arquitetura

### 1. **Falta de Camadas Definidas**

**Atual:**
```
src/
├── controllers/   (HTTP)
├── services/      (Business Logic + DB + External APIs)
├── bots/          (?)
├── routines/      (?)
└── message-flow/  (?)
```

**Problemas:**
- Services fazem TUDO (DB, lógica, APIs externas)
- Não há separação entre domínio e infraestrutura
- Difícil entender o fluxo de dados

**Solução - Clean Architecture:**
```
src/
├── domain/                    # Regras de negócio puras
│   ├── entities/              # Entidades do domínio
│   ├── value-objects/         # Objetos de valor
│   ├── repositories/          # Interfaces dos repositórios
│   └── use-cases/            # Casos de uso
├── application/               # Orquestração
│   ├── services/              # Services de aplicação
│   └── dtos/                  # Data Transfer Objects
├── infrastructure/            # Implementações concretas
│   ├── database/
│   │   ├── prisma/           # Configuração Prisma
│   │   └── repositories/     # Implementação dos repos
│   ├── http/
│   │   ├── controllers/
│   │   ├── middlewares/
│   │   └── routes/
│   ├── whatsapp/             # Clients WhatsApp
│   ├── messaging/            # Socket, eventos
│   └── external/             # APIs externas
└── shared/                   # Código compartilhado
    ├── config/
    ├── errors/
    ├── utils/
    └── types/
```

---

### 2. **Falta de Repository Pattern**

**Problema Atual:**
```typescript
// ❌ Prisma espalhado por todo código
import prismaService from "./prisma.service";

const chat = await prismaService.wppChat.findUnique({ ... });
const message = await prismaService.wppMessage.create({ ... });
```

**Problemas:**
- Difícil trocar ORM no futuro
- Queries complexas espalhadas
- Impossível testar sem banco

**Solução:**
```typescript
// ✅ Repository Pattern
interface IMessageRepository {
    findById(id: number): Promise<Message | null>;
    findByChat(chatId: number): Promise<Message[]>;
    create(data: CreateMessageDTO): Promise<Message>;
    update(id: number, data: Partial<Message>): Promise<Message>;
}

class PrismaMessageRepository implements IMessageRepository {
    constructor(private prisma: PrismaClient) {}
    
    async findById(id: number): Promise<Message | null> {
        return this.prisma.wppMessage.findUnique({ where: { id } });
    }
    
    // ... outros métodos
}
```

---

### 3. **Falta de Use Cases**

**Problema:**
```typescript
// ❌ Lógica de negócio espalhada em services
class ChatsService {
    // Mistura de queries, validações, regras de negócio
    async startChatByContactId(session, token, contactId, template) {
        const contact = await prisma.findUnique(...);
        if (!contact) throw new Error("Contato não encontrado!");
        
        await this.checkIfChatExistsOrThrow(...);
        const profilePicture = await whatsapp.getProfilePicture(...);
        const newChat = await prisma.create(...);
        const user = await users.getUserById(...);
        await messagesDistribution.addSystemMessage(...);
        await messagesDistribution.notifyChatStarted(...);
        // ... muito mais
    }
}
```

**Solução:**
```typescript
// ✅ Use Case focado
@injectable()
class StartChatUseCase {
    constructor(
        private contactRepo: IContactRepository,
        private chatRepo: IChatRepository,
        private whatsappService: IWhatsappService,
        private eventEmitter: IEventEmitter
    ) {}
    
    async execute(input: StartChatInput): Promise<StartChatOutput> {
        // 1. Validar entrada
        const contact = await this.contactRepo.findById(input.contactId);
        if (!contact) throw new ContactNotFoundError();
        
        // 2. Regras de negócio
        const existingChat = await this.chatRepo.findActiveByContact(contact.id);
        if (existingChat) throw new ChatAlreadyExistsError();
        
        // 3. Criar chat
        const chat = Chat.create({
            contactId: contact.id,
            userId: input.userId,
            // ...
        });
        
        // 4. Persistir
        await this.chatRepo.save(chat);
        
        // 5. Emitir evento
        this.eventEmitter.emit(new ChatStartedEvent(chat));
        
        return { chat };
    }
}
```

---

### 4. **Falta de Event-Driven Architecture**

**Problema:**
```typescript
// ❌ Acoplamento temporal
const newChat = await prismaService.wppChat.create(...);
await messagesDistributionService.addSystemMessage(newChat, message);
await messagesDistributionService.notifyChatStarted(process, newChat);
await whatsappService.sendTemplate(...); // Se falhar, o que acontece?
```

**Solução:**
```typescript
// ✅ Event-driven
class StartChatUseCase {
    async execute(input: StartChatInput) {
        const chat = await this.chatRepo.save(...);
        
        // Emitir evento - processamento assíncrono
        this.eventBus.publish(new ChatStartedEvent({
            chatId: chat.id,
            contactId: chat.contactId,
            userId: chat.userId
        }));
        
        return chat;
    }
}

// Handlers separados
@EventHandler(ChatStartedEvent)
class SendWelcomeMessageHandler {
    async handle(event: ChatStartedEvent) {
        await this.messageService.sendSystemMessage(
            event.chatId,
            "Atendimento iniciado!"
        );
    }
}

@EventHandler(ChatStartedEvent)
class NotifySocketHandler {
    async handle(event: ChatStartedEvent) {
        await this.socketService.emit(
            `chat:${event.chatId}`,
            { type: 'chat-started', data: event }
        );
    }
}
```

---

## 💻 Problemas de Código

### 1. **Funções Muito Longas**

**Exemplos:**
- `whatsappService.sendMessage()` - 150+ linhas
- `whatsappService.forwardMessages()` - 200+ linhas
- `chatsService.getUserChatsBySession()` - 100+ linhas

**Solução:**
Quebrar em funções menores e focadas:
```typescript
// ❌ Função longa
async sendMessage(session, to, data) {
    // 150 linhas de código
}

// ✅ Funções pequenas
async sendMessage(session, to, data) {
    const client = await this.getClient(session);
    const message = await this.prepareMessage(data);
    const options = await this.prepareOptions(message, data);
    
    const pending = await this.savePendingMessage(message);
    const sent = await client.sendMessage(options);
    
    return this.updateSentMessage(pending, sent);
}
```

---

### 2. **Código Duplicado**

**Exemplo:**
```typescript
// ❌ Repetido em vários lugares
const customer = customers.find(c => c.CODIGO === contact.customerId) || null;

// ❌ Lógica de erro repetida
} catch (err) {
    process.failed("Erro: " + sanitizeErrorMessage(err));
    throw new BadRequestError("Erro", err);
}
```

**Solução:**
```typescript
// ✅ Extrair para funções
class CustomerHelper {
    static findCustomerByContact(customers: Customer[], contact: Contact) {
        return customers.find(c => c.CODIGO === contact.customerId) ?? null;
    }
}

// ✅ Decorator para erro
function HandleError(errorMessage: string) {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        const originalMethod = descriptor.value;
        
        descriptor.value = async function (...args: any[]) {
            try {
                return await originalMethod.apply(this, args);
            } catch (err) {
                Logger.error(errorMessage, err);
                throw new ApplicationError(errorMessage, err);
            }
        };
    };
}
```

---

### 3. **Magic Numbers e Strings**

**Problema:**
```typescript
// ❌ Magic numbers
if (session.sectorId === 3 || session.instance !== "nunes") { }
if (currChat.botId === 1) { }
if (currChat.botId === 2) { }
if (resultId === -50) { }
if (currChat.instance === "vollo") { }
```

**Solução:**
```typescript
// ✅ Constantes nomeadas
const SECTOR_IDS = {
    TI: 3,
    VENDAS: 1,
    SUPORTE: 2
} as const;

const BOT_IDS = {
    CHOOSE_SECTOR: 1,
    SATISFACTION: 2
} as const;

const RESULT_IDS = {
    SYSTEM_FINISHED: -50
} as const;

const INSTANCES = {
    VOLLO: "vollo",
    NUNES: "nunes",
    EXATRON: "exatron"
} as const;

// Uso:
if (session.sectorId === SECTOR_IDS.TI) { }
if (currChat.botId === BOT_IDS.CHOOSE_SECTOR) { }
```

---

### 4. **Comentários ao Invés de Código Claro**

**Problema:**
```typescript
// ❌ Comentário explicando código ruim
// Obtém todos os chats internos do usuário
const result = await prismaService.internalChat.findMany({ ... });

// ❌ Código comentado
/* await messageForwardingService.forwardMessages({
    session: req.session,
    messageIds,
    sourceType,
    whatsappTargets
}); */
```

**Solução:**
```typescript
// ✅ Código auto-explicativo
const userInternalChats = await this.chatRepo.findAllByUser(userId);

// ✅ Remover código comentado - usar Git!
```

---

### 5. **Uso de `@ts-ignore`**

**Encontrado:**
```typescript
// @ts-ignore
app.use(handleRequestError);
```

**Problema:**
- Esconde erros de tipo
- Cria débito técnico

**Solução:**
```typescript
// ✅ Tipar corretamente
import { ErrorRequestHandler } from "express";

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
    // ...
};

app.use(errorHandler);
```

---

## ⚡ Problemas de Performance

### 1. **Queries Não Otimizadas**

**Problema:**
```typescript
// ❌ Busca tudo, sempre
const foundChats = await prismaService.wppChat.findMany({
    where: { ... },
    include: {
        contact: {
            include: {
                WppMessage: true  // ❌ TODAS as mensagens!
            }
        }
    }
});
```

**Solução:**
```typescript
// ✅ Paginação e limites
const foundChats = await prismaService.wppChat.findMany({
    where: { ... },
    include: {
        contact: {
            include: {
                WppMessage: {
                    take: 50,  // Últimas 50 mensagens
                    orderBy: { sentAt: 'desc' }
                }
            }
        }
    }
});
```

---

### 2. **Falta de Cache**

**Problema:**
```typescript
// ❌ Busca o mesmo dado repetidamente
const sectors = await prismaService.wppSector.findMany({
    where: { instance }
});
```

**Solução:**
```typescript
// ✅ Cache com Redis
@Cacheable({ ttl: 300 }) // 5 minutos
async getSectorsByInstance(instance: string) {
    return this.prisma.wppSector.findMany({
        where: { instance }
    });
}
```

---

### 3. **Processamento Síncrono de Tarefas Pesadas**

**Problema:**
```typescript
// ❌ Bloqueia a thread principal
const convertedAudio = await WhatsappAudioConverter.convertToCompatible(...);
const savedFile = await filesService.uploadFile(...);
await whatsappService.sendTemplate(...);
```

**Solução:**
```typescript
// ✅ Usar fila de processamento (Bull/BullMQ)
await this.queue.add('convert-audio', {
    audioBuffer: data.file.buffer,
    mimeType: data.file.mimetype
});

// Worker separado processa
```

---

## 🔒 Problemas de Segurança

### 1. **Falta de Rate Limiting**

**Problema:**
```typescript
// ❌ Qualquer um pode enviar quantas mensagens quiser
this.router.post("/api/whatsapp/messages", isAuthenticated, this.sendMessage);
```

**Solução:**
```typescript
// ✅ Rate limiting
import rateLimit from "express-rate-limit";

const messageLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    max: 10, // 10 mensagens por minuto
    message: "Muitas mensagens enviadas. Aguarde um momento."
});

this.router.post(
    "/api/whatsapp/messages",
    isAuthenticated,
    messageLimiter,
    this.sendMessage
);
```

---

### 2. **Falta de Sanitização de Inputs**

**Problema:**
```typescript
// ❌ Body direto no banco
const message = {
    body: data.text || "", // ❌ Pode ter scripts, SQL, etc
    // ...
};
```

**Solução:**
```typescript
// ✅ Sanitizar entradas
import DOMPurify from "isomorphic-dompurify";

const sanitizedText = DOMPurify.sanitize(data.text);
```

---

### 3. **Tokens e Secrets no Código**

**Verificar:**
- Não encontrei secrets hardcoded (✅ BOM!)
- Mas falta validação se `.env` tem todas variáveis necessárias

**Solução:**
```typescript
// ✅ Validar env na inicialização
import { z } from "zod";

const EnvSchema = z.object({
    WHATSAPP_DATABASE_URL: z.string().url(),
    LISTEN_PORT: z.string().transform(Number),
    // ... todas as variáveis obrigatórias
});

const env = EnvSchema.parse(process.env);
```

---

## 🗄️ Análise do Schema do Banco

### Pontos Positivos
- ✅ Uso de enums
- ✅ Índices básicos
- ✅ Relacionamentos bem definidos
- ✅ Campos de auditoria (createdAt, updatedAt)

### Problemas Encontrados

#### 1. **Falta de Índices Compostos**
```prisma
// ❌ Queries comuns sem índice
model WppChat {
    instance String
    isFinished Boolean
    userId Int?
    
    // Falta: @@index([instance, isFinished, userId])
}

model WppMessage {
    instance String
    chatId Int?
    sentAt DateTime
    
    // Falta: @@index([instance, chatId, sentAt])
}
```

#### 2. **Campos Opcionais Demais**
```prisma
model WppChat {
    userId Int? // ❌ Chat sem usuário?
    sectorId Int? // ❌ Chat sem setor?
}
```

**Sugestão:**
```prisma
model WppChat {
    userId Int @default(-1) // Sistema
    sectorId Int // Obrigatório
}
```

#### 3. **Falta de Soft Delete Consistente**
```prisma
model WppContact {
    isDeleted Boolean @default(false) // ✅ Tem
}

model WppChat {
    // ❌ Não tem soft delete
    // Adicionar: deletedAt DateTime?
}
```

#### 4. **Tipos de Dados Inadequados**
```prisma
model WppMessage {
    timestamp String // ❌ Deveria ser DateTime ou BigInt
    fileSize String? // ❌ Deveria ser Int ou BigInt
}
```

---

## 📝 Plano de Refatoração

### Fase 1: Fundação (2-3 semanas)
**Prioridade: CRÍTICA**

#### 1.1. Setup de Testes
- [ ] Instalar Jest + ts-jest
- [ ] Configurar coverage
- [ ] Criar primeiros testes de exemplo
- [ ] CI/CD com testes automáticos

#### 1.2. Dependency Injection
- [ ] Instalar tsyringe
- [ ] Criar container de DI
- [ ] Migrar 1 service como exemplo
- [ ] Documentar padrão

#### 1.3. Error Handling
- [ ] Criar classes de erro customizadas
- [ ] Centralizar error handling
- [ ] Padronizar logs
- [ ] Criar error tracking (Sentry?)

#### 1.4. Validação de Inputs
- [ ] Instalar Zod
- [ ] Criar schemas de validação
- [ ] Aplicar em todos controllers

---

### Fase 2: Arquitetura (3-4 semanas)
**Prioridade: ALTA**

#### 2.1. Repository Pattern
- [ ] Criar interfaces de repositórios
- [ ] Implementar repositórios Prisma
- [ ] Migrar queries dos services

#### 2.2. Use Cases
- [ ] Identificar use cases principais
- [ ] Criar estrutura de use cases
- [ ] Migrar lógica dos services

#### 2.3. Reestruturar Pastas
- [ ] Criar nova estrutura
- [ ] Migrar arquivos gradualmente
- [ ] Atualizar imports

#### 2.4. Domain Entities
- [ ] Criar entidades de domínio
- [ ] Separar de modelos Prisma
- [ ] Adicionar validações de domínio

---

### Fase 3: Refatoração de Services (4-5 semanas)
**Prioridade: ALTA**

#### 3.1. Quebrar WhatsappService
- [ ] Extrair WhatsappClientManager
- [ ] Extrair MessageSender
- [ ] Extrair TemplateService
- [ ] Extrair ConversationWindowChecker

#### 3.2. Quebrar ChatsService
- [ ] Extrair ChatCreator
- [ ] Extrair ChatFinder
- [ ] Extrair ChatFinisher
- [ ] Extrair ChatTransferrer

#### 3.3. Refatorar MessagesDistributionService
- [ ] Implementar Event-Driven
- [ ] Criar handlers separados
- [ ] Remover acoplamento

#### 3.4. Refatorar Bots
- [ ] Mover estado para banco
- [ ] Criar BotEngine genérico
- [ ] Implementar state machine

---

### Fase 4: Performance e Qualidade (2-3 semanas)
**Prioridade: MÉDIA**

#### 4.1. Otimização de Queries
- [ ] Adicionar índices faltantes
- [ ] Implementar paginação
- [ ] Eager loading adequado
- [ ] Query analysis

#### 4.2. Cache
- [ ] Setup Redis
- [ ] Cache de sectors
- [ ] Cache de usuários
- [ ] Cache de templates

#### 4.3. Background Jobs
- [ ] Setup Bull/BullMQ
- [ ] Migrar conversão de áudio
- [ ] Migrar upload de arquivos
- [ ] Migrar notificações

#### 4.4. Documentação
- [ ] Swagger/OpenAPI
- [ ] README atualizado
- [ ] Arquitetura documentada
- [ ] Guia de contribuição

---

### Fase 5: Features e Melhorias (Contínuo)
**Prioridade: BAIXA**

#### 5.1. Monitoramento
- [ ] APM (Application Performance Monitoring)
- [ ] Métricas de negócio
- [ ] Alertas
- [ ] Dashboard

#### 5.2. Testes
- [ ] Testes unitários (80%+ coverage)
- [ ] Testes de integração
- [ ] Testes E2E
- [ ] Testes de carga

---

## 🏛️ Arquitetura Proposta

### Estrutura de Diretórios

```
whatsapp-service/
├── src/
│   ├── domain/                           # Camada de Domínio
│   │   ├── entities/
│   │   │   ├── Chat.ts
│   │   │   ├── Message.ts
│   │   │   ├── Contact.ts
│   │   │   └── Sector.ts
│   │   ├── value-objects/
│   │   │   ├── Phone.ts
│   │   │   ├── MessageContent.ts
│   │   │   └── ChatStatus.ts
│   │   ├── repositories/                 # Interfaces
│   │   │   ├── IChatRepository.ts
│   │   │   ├── IMessageRepository.ts
│   │   │   └── IContactRepository.ts
│   │   ├── services/                     # Domain Services
│   │   │   ├── IWhatsappClient.ts
│   │   │   └── IFileStorage.ts
│   │   └── events/
│   │       ├── ChatStartedEvent.ts
│   │       ├── MessageSentEvent.ts
│   │       └── ChatFinishedEvent.ts
│   │
│   ├── application/                      # Camada de Aplicação
│   │   ├── use-cases/
│   │   │   ├── chat/
│   │   │   │   ├── StartChatUseCase.ts
│   │   │   │   ├── FinishChatUseCase.ts
│   │   │   │   └── TransferChatUseCase.ts
│   │   │   ├── message/
│   │   │   │   ├── SendMessageUseCase.ts
│   │   │   │   ├── ForwardMessageUseCase.ts
│   │   │   │   └── EditMessageUseCase.ts
│   │   │   └── contact/
│   │   │       └── CreateContactUseCase.ts
│   │   ├── dtos/
│   │   │   ├── StartChatDTO.ts
│   │   │   └── SendMessageDTO.ts
│   │   └── services/
│   │       ├── MessageDistributionService.ts
│   │       └── NotificationService.ts
│   │
│   ├── infrastructure/                   # Camada de Infraestrutura
│   │   ├── database/
│   │   │   ├── prisma/
│   │   │   │   ├── client.ts
│   │   │   │   └── schema.prisma
│   │   │   ├── repositories/
│   │   │   │   ├── PrismaChatRepository.ts
│   │   │   │   ├── PrismaMessageRepository.ts
│   │   │   │   └── PrismaContactRepository.ts
│   │   │   └── migrations/
│   │   │
│   │   ├── http/
│   │   │   ├── controllers/
│   │   │   │   ├── ChatsController.ts
│   │   │   │   ├── MessagesController.ts
│   │   │   │   └── ContactsController.ts
│   │   │   ├── middlewares/
│   │   │   │   ├── AuthMiddleware.ts
│   │   │   │   ├── ErrorMiddleware.ts
│   │   │   │   └── ValidationMiddleware.ts
│   │   │   ├── routes/
│   │   │   │   └── index.ts
│   │   │   └── server.ts
│   │   │
│   │   ├── whatsapp/
│   │   │   ├── clients/
│   │   │   │   ├── WWEBJSClient.ts
│   │   │   │   ├── WABAClient.ts
│   │   │   │   └── GupshupClient.ts
│   │   │   ├── adapters/
│   │   │   │   ├── MessageAdapter.ts
│   │   │   │   └── TemplateAdapter.ts
│   │   │   └── WhatsappClientFactory.ts
│   │   │
│   │   ├── messaging/
│   │   │   ├── SocketService.ts
│   │   │   └── EventBus.ts
│   │   │
│   │   ├── storage/
│   │   │   ├── FileStorageService.ts
│   │   │   └── AudioConverter.ts
│   │   │
│   │   ├── cache/
│   │   │   └── RedisCache.ts
│   │   │
│   │   ├── queue/
│   │   │   ├── BullQueue.ts
│   │   │   └── workers/
│   │   │
│   │   └── external/
│   │       └── InPulseAPI.ts
│   │
│   ├── shared/                          # Código Compartilhado
│   │   ├── config/
│   │   │   ├── env.ts
│   │   │   └── constants.ts
│   │   ├── errors/
│   │   │   ├── ApplicationError.ts
│   │   │   ├── DomainError.ts
│   │   │   └── InfrastructureError.ts
│   │   ├── utils/
│   │   │   ├── logger.ts
│   │   │   ├── formatter.ts
│   │   │   └── validators.ts
│   │   └── types/
│   │       └── global.d.ts
│   │
│   └── main.ts                          # Entry point
│
├── tests/
│   ├── unit/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   ├── integration/
│   └── e2e/
│
├── docs/
│   ├── architecture/
│   │   ├── decisions/                   # ADRs
│   │   ├── diagrams/
│   │   └── overview.md
│   ├── api/
│   │   └── openapi.yaml
│   └── guides/
│       ├── development.md
│       └── deployment.md
│
└── scripts/
    ├── setup.sh
    └── migrate.sh
```

---

### Exemplo de Implementação

#### Use Case
```typescript
// src/application/use-cases/message/SendMessageUseCase.ts
import { injectable, inject } from "tsyringe";

interface SendMessageInput {
    sessionId: string;
    to: string;
    text?: string;
    fileId?: number;
    chatId?: number;
}

@injectable()
export class SendMessageUseCase {
    constructor(
        @inject("IMessageRepository") 
        private messageRepo: IMessageRepository,
        
        @inject("IWhatsappClientManager") 
        private whatsappManager: IWhatsappClientManager,
        
        @inject("IEventBus") 
        private eventBus: IEventBus,
        
        @inject("ILogger") 
        private logger: ILogger
    ) {}

    async execute(input: SendMessageInput): Promise<Message> {
        this.logger.info("Sending message", { input });

        // 1. Obter cliente WhatsApp
        const client = await this.whatsappManager.getClientBySession(
            input.sessionId
        );

        // 2. Criar entidade de domínio
        const message = Message.create({
            from: client.phone,
            to: input.to,
            content: input.text,
            chatId: input.chatId
        });

        // 3. Validar regras de negócio
        message.validate();

        // 4. Persistir como pendente
        await this.messageRepo.save(message);

        // 5. Emitir evento
        this.eventBus.publish(new MessageCreatedEvent(message));

        // 6. Enviar (assíncrono via evento)
        this.eventBus.publish(new SendMessageToWhatsappEvent(message));

        return message;
    }
}
```

#### Repository
```typescript
// src/infrastructure/database/repositories/PrismaMessageRepository.ts
import { injectable } from "tsyringe";
import { PrismaClient } from "@prisma/client";
import { IMessageRepository } from "@domain/repositories/IMessageRepository";
import { Message } from "@domain/entities/Message";

@injectable()
export class PrismaMessageRepository implements IMessageRepository {
    constructor(private prisma: PrismaClient) {}

    async save(message: Message): Promise<void> {
        await this.prisma.wppMessage.create({
            data: {
                from: message.from,
                to: message.to,
                body: message.content,
                status: message.status,
                // ... mapper
            }
        });
    }

    async findById(id: number): Promise<Message | null> {
        const data = await this.prisma.wppMessage.findUnique({
            where: { id }
        });

        if (!data) return null;

        return Message.fromPersistence(data);
    }
}
```

#### Controller
```typescript
// src/infrastructure/http/controllers/MessagesController.ts
import { Request, Response } from "express";
import { injectable, inject } from "tsyringe";
import { SendMessageUseCase } from "@application/use-cases/message/SendMessageUseCase";

@injectable()
export class MessagesController {
    constructor(
        @inject(SendMessageUseCase)
        private sendMessageUseCase: SendMessageUseCase
    ) {}

    async sendMessage(req: Request, res: Response) {
        const result = await this.sendMessageUseCase.execute({
            sessionId: req.session.id,
            to: req.body.to,
            text: req.body.text,
            chatId: req.body.chatId
        });

        res.status(201).json({
            message: "Message sent successfully",
            data: result
        });
    }
}
```

---

## ⏱️ Estimativas e Prioridades

### Resumo de Esforço

| Fase | Duração | Prioridade | Impacto |
|------|---------|------------|---------|
| Fase 1: Fundação | 2-3 semanas | 🔴 CRÍTICA | Alto |
| Fase 2: Arquitetura | 3-4 semanas | 🟡 ALTA | Muito Alto |
| Fase 3: Refatoração | 4-5 semanas | 🟡 ALTA | Alto |
| Fase 4: Performance | 2-3 semanas | 🟢 MÉDIA | Médio |
| Fase 5: Melhorias | Contínuo | 🔵 BAIXA | Variável |

### Total Estimado: 11-15 semanas (3-4 meses)

---

### Priorização por Impacto vs Esforço

#### Quick Wins (Alto Impacto, Baixo Esforço)
1. ✅ Adicionar validação de inputs (Zod) - 3 dias
2. ✅ Centralizar error handling - 2 dias
3. ✅ Adicionar índices no banco - 1 dia
4. ✅ Configurar rate limiting - 1 dia
5. ✅ Remover `any` types - 5 dias

#### Investimentos Estratégicos (Alto Impacto, Alto Esforço)
1. 🎯 Implementar DI - 1 semana
2. 🎯 Repository Pattern - 2 semanas
3. 🎯 Use Cases - 2 semanas
4. 🎯 Quebrar God Classes - 3 semanas

#### Melhorias Futuras (Baixo Impacto, Variável Esforço)
1. 📊 Monitoramento avançado
2. 📊 Testes E2E completos
3. 📊 Documentação extensiva

---

## 🎬 Próximos Passos Recomendados

### Semana 1-2: Quick Wins
1. Configurar Zod e validar todos inputs
2. Centralizar error handling
3. Adicionar índices no banco
4. Setup inicial de testes
5. Configurar rate limiting

### Semana 3-4: Fundação
1. Implementar DI com tsyringe
2. Criar primeiros testes
3. Padronizar logs
4. Documentar decisões (ADRs)

### Semana 5-8: Arquitetura
1. Implementar Repository Pattern
2. Criar Use Cases principais
3. Reestruturar pastas
4. Migrar 1 feature completa como exemplo

### Semana 9+: Refatoração Contínua
1. Quebrar services grandes
2. Implementar eventos
3. Otimizar performance
4. Aumentar coverage de testes

---

## 📚 Recursos e Referências

### Livros Recomendados
- Clean Architecture - Robert C. Martin
- Domain-Driven Design - Eric Evans
- Refactoring - Martin Fowler

### Padrões e Princípios
- SOLID Principles
- Repository Pattern
- Use Case Pattern
- Event-Driven Architecture
- Dependency Injection

### Ferramentas Sugeridas
- **DI**: tsyringe
- **Validação**: Zod
- **Testes**: Jest + Supertest
- **Cache**: Redis
- **Queue**: BullMQ
- **APM**: Sentry / New Relic
- **Docs**: Swagger / OpenAPI

---

## ✅ Checklist de Qualidade

### Código
- [ ] Sem uso de `any`
- [ ] Sem `@ts-ignore`
- [ ] Funções com max 30 linhas
- [ ] Classes com max 200 linhas
- [ ] Coverage > 80%
- [ ] Sem código duplicado

### Arquitetura
- [ ] Separação clara de camadas
- [ ] Dependency Injection
- [ ] Repository Pattern
- [ ] Use Cases bem definidos
- [ ] Event-Driven onde apropriado

### Performance
- [ ] Queries otimizadas
- [ ] Índices adequados
- [ ] Cache implementado
- [ ] Background jobs para tarefas pesadas
- [ ] Paginação em listas

### Segurança
- [ ] Rate limiting
- [ ] Validação de inputs
- [ ] Sanitização de dados
- [ ] Logs não expõem dados sensíveis
- [ ] Env vars validadas

### Documentação
- [ ] README atualizado
- [ ] API documentada (Swagger)
- [ ] Arquitetura documentada
- [ ] ADRs para decisões importantes
- [ ] Comentários apenas onde necessário

---

## 🎓 Conclusão

Este projeto tem **muito potencial**, mas precisa de **refatoração significativa** para ser:
- ✅ Testável
- ✅ Manutenível
- ✅ Escalável
- ✅ Performático

**A boa notícia:** A base está sólida (TypeScript, Prisma, Express). Precisamos "apenas" reorganizar e aplicar boas práticas.

**Recomendação:** Começar pelos Quick Wins para ganhar momentum, depois investir nas mudanças arquiteturais maiores de forma incremental.

---

**Autor:** GitHub Copilot  
**Data:** 15 de Outubro de 2025  
**Versão:** 1.0
