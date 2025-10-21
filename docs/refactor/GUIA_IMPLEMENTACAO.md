# 🚀 Guia de Implementação - Primeiros Passos

Este documento contém exemplos práticos para começar a refatoração do projeto.

---

## 1️⃣ Setup Inicial - Dependency Injection

### Instalação
```bash
npm install tsyringe reflect-metadata
npm install -D @types/node
```

### Configuração

**tsconfig.json** - Adicionar:
```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

**src/shared/container/index.ts** - Criar:
```typescript
import "reflect-metadata";
import { container } from "tsyringe";
import { PrismaClient } from "@prisma/client";

// Database
const prismaClient = new PrismaClient();
container.registerInstance("PrismaClient", prismaClient);

// Repositories
import { IMessageRepository } from "@domain/repositories/IMessageRepository";
import { PrismaMessageRepository } from "@infrastructure/database/repositories/PrismaMessageRepository";
container.registerSingleton<IMessageRepository>(
  "IMessageRepository",
  PrismaMessageRepository
);

// Use Cases
import { SendMessageUseCase } from "@application/use-cases/message/SendMessageUseCase";
container.registerSingleton(SendMessageUseCase);

export { container };
```

**src/main.ts** - Atualizar:
```typescript
import "reflect-metadata"; // 👈 IMPORTANTE: Antes de tudo!
import "./shared/container"; // 👈 Registrar dependências
import express from "express";
import { container } from "tsyringe";

const app = express();

// Usar container para resolver dependências
const messagesController = container.resolve(MessagesController);

app.use("/api/messages", messagesController.router);
```

---

## 2️⃣ Validação com Zod

### Instalação
```bash
npm install zod
```

### Exemplo de Schema

**src/application/dtos/SendMessageDTO.ts**
```typescript
import { z } from "zod";

export const SendMessageSchema = z.object({
  to: z.string()
    .min(10, "Telefone deve ter no mínimo 10 dígitos")
    .max(15, "Telefone deve ter no máximo 15 dígitos")
    .regex(/^[0-9]+$/, "Telefone deve conter apenas números"),
    
  text: z.string()
    .min(1, "Texto não pode ser vazio")
    .max(4096, "Texto muito longo")
    .optional(),
    
  chatId: z.number()
    .int("Chat ID deve ser um número inteiro")
    .positive("Chat ID deve ser positivo")
    .optional(),
    
  contactId: z.number()
    .int()
    .positive(),
    
  quotedId: z.number()
    .int()
    .positive()
    .optional(),
    
  sendAsAudio: z.boolean()
    .default(false),
});

export type SendMessageDTO = z.infer<typeof SendMessageSchema>;
```

### Middleware de Validação

**src/infrastructure/http/middlewares/ValidationMiddleware.ts**
```typescript
import { Request, Response, NextFunction } from "express";
import { ZodSchema } from "zod";
import { BadRequestError } from "@shared/errors/ApplicationError";

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }));
        
        throw new BadRequestError("Validation failed", { errors });
      }
      next(error);
    }
  };
}
```

### Uso no Controller

**src/infrastructure/http/controllers/MessagesController.ts**
```typescript
import { Router } from "express";
import { validate } from "@infrastructure/http/middlewares/ValidationMiddleware";
import { SendMessageSchema } from "@application/dtos/SendMessageDTO";

export class MessagesController {
  public router = Router();

  constructor(
    private sendMessageUseCase: SendMessageUseCase
  ) {
    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.post(
      "/",
      isAuthenticated,
      validate(SendMessageSchema), // 👈 Validação automática
      this.sendMessage.bind(this)
    );
  }

  private async sendMessage(req: Request, res: Response) {
    // req.body já está validado e tipado!
    const result = await this.sendMessageUseCase.execute({
      sessionId: req.session.id,
      ...req.body
    });

    res.status(201).json(result);
  }
}
```

---

## 3️⃣ Repository Pattern

### Interface do Repositório

**src/domain/repositories/IMessageRepository.ts**
```typescript
import { Message } from "@domain/entities/Message";

export interface IMessageRepository {
  findById(id: number): Promise<Message | null>;
  findByChat(chatId: number, options?: FindOptions): Promise<Message[]>;
  findByContact(contactId: number): Promise<Message[]>;
  save(message: Message): Promise<void>;
  update(id: number, data: Partial<Message>): Promise<void>;
  delete(id: number): Promise<void>;
}

interface FindOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'asc' | 'desc';
}
```

### Implementação com Prisma

**src/infrastructure/database/repositories/PrismaMessageRepository.ts**
```typescript
import { injectable, inject } from "tsyringe";
import { PrismaClient } from "@prisma/client";
import { IMessageRepository } from "@domain/repositories/IMessageRepository";
import { Message } from "@domain/entities/Message";

@injectable()
export class PrismaMessageRepository implements IMessageRepository {
  constructor(
    @inject("PrismaClient") 
    private prisma: PrismaClient
  ) {}

  async findById(id: number): Promise<Message | null> {
    const data = await this.prisma.wppMessage.findUnique({
      where: { id }
    });

    if (!data) return null;

    return this.toDomain(data);
  }

  async findByChat(
    chatId: number, 
    options: FindOptions = {}
  ): Promise<Message[]> {
    const messages = await this.prisma.wppMessage.findMany({
      where: { chatId },
      take: options.limit,
      skip: options.offset,
      orderBy: { sentAt: options.orderBy || 'desc' }
    });

    return messages.map(this.toDomain);
  }

  async save(message: Message): Promise<void> {
    await this.prisma.wppMessage.create({
      data: this.toPersistence(message)
    });
  }

  async update(id: number, data: Partial<Message>): Promise<void> {
    await this.prisma.wppMessage.update({
      where: { id },
      data: this.toPersistence(data)
    });
  }

  async delete(id: number): Promise<void> {
    await this.prisma.wppMessage.delete({
      where: { id }
    });
  }

  // Mappers
  private toDomain(data: any): Message {
    return Message.fromPersistence({
      id: data.id,
      from: data.from,
      to: data.to,
      body: data.body,
      status: data.status,
      sentAt: data.sentAt,
      // ...
    });
  }

  private toPersistence(message: Partial<Message>): any {
    return {
      from: message.from,
      to: message.to,
      body: message.body,
      status: message.status,
      sentAt: message.sentAt,
      // ...
    };
  }
}
```

---

## 4️⃣ Use Case Pattern

### Estrutura do Use Case

**src/application/use-cases/message/SendMessageUseCase.ts**
```typescript
import { injectable, inject } from "tsyringe";
import { IMessageRepository } from "@domain/repositories/IMessageRepository";
import { IWhatsappClient } from "@domain/services/IWhatsappClient";
import { IEventBus } from "@domain/services/IEventBus";
import { Message } from "@domain/entities/Message";
import { MessageSentEvent } from "@domain/events/MessageSentEvent";

interface SendMessageInput {
  sessionId: string;
  to: string;
  text?: string;
  chatId?: number;
  contactId: number;
}

interface SendMessageOutput {
  message: Message;
}

@injectable()
export class SendMessageUseCase {
  constructor(
    @inject("IMessageRepository")
    private messageRepo: IMessageRepository,
    
    @inject("IWhatsappClient")
    private whatsappClient: IWhatsappClient,
    
    @inject("IEventBus")
    private eventBus: IEventBus
  ) {}

  async execute(input: SendMessageInput): Promise<SendMessageOutput> {
    // 1. Validar regras de negócio
    this.validate(input);

    // 2. Criar entidade de domínio
    const message = Message.create({
      from: input.sessionId,
      to: input.to,
      content: input.text,
      chatId: input.chatId,
      contactId: input.contactId,
      status: 'PENDING'
    });

    // 3. Persistir
    await this.messageRepo.save(message);

    // 4. Enviar para WhatsApp (assíncrono)
    this.eventBus.publish(
      new MessageSentEvent(message)
    );

    return { message };
  }

  private validate(input: SendMessageInput): void {
    if (!input.text && !input.fileId) {
      throw new Error("Message must have text or file");
    }
  }
}
```

### Event Handler

**src/application/handlers/SendToWhatsappHandler.ts**
```typescript
import { injectable, inject } from "tsyringe";
import { IEventHandler } from "@domain/services/IEventHandler";
import { MessageSentEvent } from "@domain/events/MessageSentEvent";
import { IWhatsappClient } from "@domain/services/IWhatsappClient";
import { IMessageRepository } from "@domain/repositories/IMessageRepository";

@injectable()
export class SendToWhatsappHandler implements IEventHandler<MessageSentEvent> {
  constructor(
    @inject("IWhatsappClient")
    private whatsappClient: IWhatsappClient,
    
    @inject("IMessageRepository")
    private messageRepo: IMessageRepository
  ) {}

  async handle(event: MessageSentEvent): Promise<void> {
    try {
      // Enviar para WhatsApp
      const result = await this.whatsappClient.sendMessage({
        to: event.message.to,
        text: event.message.content
      });

      // Atualizar status
      await this.messageRepo.update(event.message.id, {
        status: 'SENT',
        wwebjsId: result.id
      });
    } catch (error) {
      // Marcar como erro
      await this.messageRepo.update(event.message.id, {
        status: 'ERROR'
      });
      
      throw error;
    }
  }
}
```

---

## 5️⃣ Error Handling

### Estrutura de Erros

**src/shared/errors/ApplicationError.ts**
```typescript
export class ApplicationError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public context?: any
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends ApplicationError {
  constructor(message: string, context?: any) {
    super(message, 400, context);
  }
}

export class NotFoundError extends ApplicationError {
  constructor(message: string, context?: any) {
    super(message, 404, context);
  }
}

export class UnauthorizedError extends ApplicationError {
  constructor(message: string, context?: any) {
    super(message, 401, context);
  }
}

export class ConflictError extends ApplicationError {
  constructor(message: string, context?: any) {
    super(message, 409, context);
  }
}
```

### Middleware de Erro

**src/infrastructure/http/middlewares/ErrorMiddleware.ts**
```typescript
import { Request, Response, NextFunction } from "express";
import { ApplicationError } from "@shared/errors/ApplicationError";
import { Logger } from "@shared/utils/logger";

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log do erro
  Logger.error(err.message, {
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body,
    user: req.session?.userId
  });

  // Se for erro conhecido
  if (err instanceof ApplicationError) {
    return res.status(err.statusCode).json({
      error: err.message,
      context: err.context
    });
  }

  // Erro desconhecido
  return res.status(500).json({
    error: "Internal server error"
  });
}
```

---

## 6️⃣ Testes

### Setup Jest

**jest.config.js**
```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/main.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  moduleNameMapper: {
    '^@domain/(.*)$': '<rootDir>/src/domain/$1',
    '^@application/(.*)$': '<rootDir>/src/application/$1',
    '^@infrastructure/(.*)$': '<rootDir>/src/infrastructure/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1'
  }
};
```

### Exemplo de Teste

**tests/unit/application/use-cases/SendMessageUseCase.test.ts**
```typescript
import "reflect-metadata";
import { SendMessageUseCase } from "@application/use-cases/message/SendMessageUseCase";
import { IMessageRepository } from "@domain/repositories/IMessageRepository";
import { IWhatsappClient } from "@domain/services/IWhatsappClient";
import { IEventBus } from "@domain/services/IEventBus";

// Mocks
const mockMessageRepo: jest.Mocked<IMessageRepository> = {
  save: jest.fn(),
  findById: jest.fn(),
  findByChat: jest.fn(),
  update: jest.fn(),
  delete: jest.fn()
};

const mockWhatsappClient: jest.Mocked<IWhatsappClient> = {
  sendMessage: jest.fn()
};

const mockEventBus: jest.Mocked<IEventBus> = {
  publish: jest.fn()
};

describe('SendMessageUseCase', () => {
  let useCase: SendMessageUseCase;

  beforeEach(() => {
    useCase = new SendMessageUseCase(
      mockMessageRepo,
      mockWhatsappClient,
      mockEventBus
    );
    
    jest.clearAllMocks();
  });

  it('should send a message successfully', async () => {
    // Arrange
    const input = {
      sessionId: 'session-123',
      to: '5511999999999',
      text: 'Hello World',
      contactId: 1
    };

    // Act
    const result = await useCase.execute(input);

    // Assert
    expect(mockMessageRepo.save).toHaveBeenCalledTimes(1);
    expect(mockEventBus.publish).toHaveBeenCalledTimes(1);
    expect(result.message.to).toBe(input.to);
    expect(result.message.content).toBe(input.text);
  });

  it('should throw error when no text or file', async () => {
    // Arrange
    const input = {
      sessionId: 'session-123',
      to: '5511999999999',
      contactId: 1
    };

    // Act & Assert
    await expect(useCase.execute(input))
      .rejects
      .toThrow('Message must have text or file');
  });
});
```

---

## 7️⃣ Migrações do Banco

### Adicionar Índices

**prisma/migrations/YYYYMMDDHHMMSS_add_performance_indexes/migration.sql**
```sql
-- Índices para WppMessage
CREATE INDEX idx_wpp_message_sent_at ON messages(sent_at);
CREATE INDEX idx_wpp_message_status ON messages(status);
CREATE INDEX idx_wpp_message_instance_sent_at ON messages(instance, sent_at);

-- Índices para WppChat
CREATE INDEX idx_wpp_chat_instance_finished ON chats(instance, is_finished);
CREATE INDEX idx_wpp_chat_instance_sector_finished ON chats(instance, sector_id, is_finished);

-- Índice para queries comuns de contato
CREATE INDEX idx_wpp_contact_instance_customer ON contacts(instance, customer_id);
```

### Atualizar Schema

**prisma/schema.prisma**
```prisma
model WppMessage {
  id        Int      @id @default(autoincrement())
  instance  String
  sentAt    DateTime @map("sent_at")
  status    WppMessageStatus
  
  @@index([sentAt])
  @@index([status])
  @@index([instance, sentAt])
  @@map("messages")
}

model WppChat {
  id         Int     @id @default(autoincrement())
  instance   String
  sectorId   Int?    @map("sector_id")
  isFinished Boolean @default(false) @map("is_finished")
  
  @@index([instance, isFinished])
  @@index([instance, sectorId, isFinished])
  @@map("chats")
}
```

---

## 8️⃣ Próximos Passos

1. **Criar branch de refatoração**
   ```bash
   git checkout -b refactor/architecture-improvement
   ```

2. **Implementar os exemplos acima**
   - Começar com 1 feature (ex: envio de mensagens)
   - Aplicar todos os padrões
   - Testar extensivamente

3. **Documentar o processo**
   - Criar ADRs (Architecture Decision Records)
   - Atualizar README
   - Criar guias para o time

4. **Code Review rigoroso**
   - Garantir qualidade
   - Compartilhar conhecimento
   - Refinar padrões

5. **Deployar incrementalmente**
   - Feature flags
   - Monitoramento
   - Rollback plan

---

**Boa sorte com a refatoração! 🚀**
