# 📚 Sistema de Fluxos de Mensagens - Índice Geral

## 🎯 Visão Geral

Sistema de fluxos de mensagens baseado em **Chain of Responsibility Pattern** que permite criar fluxos personalizados de distribuição de mensagens no banco de dados, oferecendo controle total sobre como os chats são atribuídos a usuários, carteiras ou admin.

---

## 📖 Documentação Disponível

### 🚀 Para Começar (Usuários)

1. **[Manual de Criação de Fluxos](./MANUAL_CRIACAO_FLUXOS.md)** ⭐ **COMECE AQUI**
   - Como funciona o sistema
   - Estrutura do banco de dados
   - Passo a passo para criar fluxos
   - Templates SQL prontos
   - Consultas úteis

2. **[Documentação Completa dos Steps](./STEPS_DOCUMENTATION.md)**
   - Todos os steps disponíveis
   - Configurações detalhadas
   - Exemplos práticos
   - Troubleshooting

3. **[Exemplos Práticos de Fluxos](./EXEMPLOS_PRATICOS_FLUXOS.md)**
   - Fluxo básico de distribuição
   - Fluxo com priorização VIP
   - Fluxo por horário
   - Fluxo por tipo de cliente
   - Fluxo com fidelização

### 🔧 Documentação Técnica (Desenvolvedores)

4. **[Nomenclatura de Steps](../refactor/NOMENCLATURA_STEPS.md)**
   - Padronização de nomes
   - stepNumber vs stepId
   - Estrutura do código
   - Changelog da refatoração

5. **[Correção do Factory](../refactor/CORRECAO_FACTORY.md)**
   - Problema com next_step_id
   - Solução implementada
   - Fluxos não-lineares
   - Breaking changes

---

## 🎓 Guia Rápido

### Você quer...

#### ✅ Criar seu primeiro fluxo?
→ Leia o **[Manual de Criação de Fluxos](./MANUAL_CRIACAO_FLUXOS.md)**

#### ✅ Entender o que cada step faz?
→ Leia a **[Documentação dos Steps](./STEPS_DOCUMENTATION.md)**

#### ✅ Ver exemplos prontos?
→ Veja os **[Exemplos Práticos](./EXEMPLOS_PRATICOS_FLUXOS.md)**

#### ✅ Entender o código?
→ Continue lendo este documento

#### ✅ Resolver problemas?
→ Veja a seção **Troubleshooting** abaixo

---

## 📋 Quick Reference

### Steps Específicos (Pré-construídos)

| Step | O que faz | Quando usar |
|------|-----------|-------------|
| `CHECK_ONLY_ADMIN` | Verifica se é admin | Primeiro step |
| `CHECK_LOALTY` | Verifica fidelização | Manter vendedor-cliente |
| `CHECK_AVAILABLE_USERS` | Distribui por carga | Balancear chats |
| `SEND_TO_ADMIN` | Envia para admin | Último step (fallback) |
| `SEND_TO_SECTOR_USER` | Envia para usuário do setor | Atribuição simples |

### Steps Genéricos (Configuráveis)

| Step | O que faz | Config principal |
|------|-----------|------------------|
| `QUERY` | Executa SQL | `query`, `storeAs` |
| `CONDITION` | If/else | `field`, `operator`, `onTrue`, `onFalse` |
| `ROUTER` | Switch/case | `field`, `routes` |
| `ASSIGN` | Atribui chat | `userId` ou `walletId` |

### Exemplo Mínimo

```sql
-- 1. Criar fluxo
INSERT INTO message_flows (instance, sector_id, description)
VALUES ('minha_instancia', 1, 'Fluxo básico');

-- 2. Adicionar steps
INSERT INTO message_flows_steps (message_flow_id, type, step_number, next_step_id) VALUES
(1, 'CHECK_ONLY_ADMIN', 1, 2),
(1, 'CHECK_LOALTY', 2, 3),
(1, 'CHECK_AVAILABLE_USERS', 3, 4),
(1, 'SEND_TO_ADMIN', 4, NULL);
```

---

## 🔍 Estrutura do Banco

```sql
message_flows
├── id (PK)
├── instance (UK com sector_id)
├── sector_id (UK com instance)
└── description

message_flows_steps
├── id (PK)
├── message_flow_id (FK)
├── type (enum)
├── step_number (UK com message_flow_id)
├── next_step_id ← Controla próximo step
├── fallback_step_id ← Step em caso de erro
├── config (JSON)
├── enabled
└── description
```

---

## 🏗️ Arquitetura do Código

## 🏗️ Architecture

```
src/message-flow/
├── base/                    # Generic steps (reusable)
│   ├── base.step.ts        # Abstract base class
│   ├── assign.step.ts      # Assign chat to user
│   ├── condition.step.ts   # Conditional branching
│   ├── query.step.ts       # Database queries
│   └── router.step.ts      # Multi-branch routing
│
├── steps/                   # Business-specific steps
│   ├── check-only-admin.step.ts
│   ├── check-loalty.step.ts
│   ├── check-available-users.step.ts
│   ├── send-to-admin.step.ts
│   └── send-to-sector-user.step.ts
│
├── step-registry.ts         # Centralized step registration
├── register-steps.ts        # Step registration loader
├── message-flow.ts          # Flow execution engine
└── message-flow.factory.ts  # Flow factory
```

## 🚀 Quick Start

### Creating a New Step

```typescript
import { BaseStep, StepConfig, StepContext, StepResult } from "../base/base.step";

export default class MyCustomStep extends BaseStep {
  constructor(config: StepConfig) {
    super(config);
  }

  async execute(ctx: StepContext): Promise<StepResult> {
    // Your logic here
    
    // Continue to next step
    return this.continue(ctx);
    
    // Or finalize with chat
    return this.finalize({
      instance: this.instance,
      type: "RECEPTIVE",
      userId: 123,
      sectorId: this.sectorId,
      contactId: ctx.contact.id
    });
  }
}
```

### Registering a Step

```typescript
// In register-steps.ts
import MyCustomStep from "./steps/my-custom.step";

StepRegistry.register("MY_CUSTOM", MyCustomStep, {
  description: "My custom step logic",
  requiredConfig: ["fieldName"],
  optionalConfig: ["timeout"]
});
```

### Using in Database

```sql
-- Create flow
INSERT INTO wpp_message_flow (instance, sectorId, name, description)
VALUES ('instance1', 1, 'Custom Flow', 'My custom flow');

-- Add step
INSERT INTO wpp_message_flow_step (flowId, type, config, nextStepId, fallbackStepId, enabled)
VALUES (
  1,                                    -- flowId
  'MY_CUSTOM',                          -- type
  '{"fieldName": "value"}',             -- config
  2,                                    -- nextStepId
  NULL,                                 -- fallbackStepId
  true                                  -- enabled
);
```

## 📖 Available Steps

### Generic Steps

| Type | Description | Config |
|------|-------------|--------|
| `CONDITION` | Conditional branching based on context | `condition`, `field`, `operator`, `value` |
| `QUERY` | Execute SQL queries and store results | `query`, `params`, `resultField` |
| `ROUTER` | Multi-branch routing based on field value | `field`, `routes` |
| `ASSIGN` | Direct chat assignment | `userId`, `walletId`, `priority` |

### Business Steps

| Type | Description | Config |
|------|-------------|--------|
| `CHECK_ONLY_ADMIN` | Check if contact is admin-only | - |
| `CHECK_LOALTY` | Check customer loyalty campaign | - |
| `CHECK_AVAILABLE_USERS` | Find available users in sector | - |
| `SEND_TO_ADMIN` | Send to sector admin | - |
| `SEND_TO_SECTOR_USER` | Send to sector user | `preferAdmin` (optional) |

## ⚙️ Configuration Examples

### Example 1: Simple Linear Flow

```json
{
  "steps": [
    {
      "type": "CHECK_ONLY_ADMIN",
      "nextStepId": 2
    },
    {
      "type": "CHECK_LOALTY",
      "nextStepId": 3
    },
    {
      "type": "CHECK_AVAILABLE_USERS",
      "nextStepId": 4
    },
    {
      "type": "SEND_TO_ADMIN"
    }
  ]
}
```

### Example 2: Conditional Flow

```json
{
  "steps": [
    {
      "type": "CONDITION",
      "config": {
        "field": "contact.isVIP",
        "operator": "==",
        "value": true
      },
      "nextStepId": 2,
      "fallbackStepId": 3
    },
    {
      "type": "ASSIGN",
      "config": {
        "userId": 100,
        "priority": "HIGH"
      }
    },
    {
      "type": "CHECK_AVAILABLE_USERS",
      "nextStepId": 4
    }
  ]
}
```

### Example 3: Router Flow

```json
{
  "steps": [
    {
      "type": "QUERY",
      "config": {
        "query": "SELECT tipo FROM clientes WHERE id = ?",
        "params": ["${contact.customerId}"],
        "resultField": "customerType"
      },
      "nextStepId": 2
    },
    {
      "type": "ROUTER",
      "config": {
        "field": "context.customerType",
        "routes": {
          "VIP": 3,
          "PREMIUM": 4,
          "DEFAULT": 5
        }
      }
    }
  ]
}
```

## 🔧 BaseStep API

### Properties

- `this.id` - Step ID
- `this.instance` - Instance name
- `this.sectorId` - Sector ID
- `this.config` - Configuration object
- `this.nextStepId` - Next step ID
- `this.fallbackStepId` - Fallback step ID (error handling)

### Methods

#### `execute(context: StepContext): Promise<StepResult>`
Main method to implement. Contains the step logic.

#### `continue(context: StepContext, stepId?: number): StepResult`
Returns result to continue to next step.

```typescript
return this.continue(ctx);           // Use this.nextStepId
return this.continue(ctx, 5);        // Go to step 5
```

#### `finalize(chatData: ChatPayload): StepResult`
Returns final result with chat creation data.

```typescript
return this.finalize({
  instance: this.instance,
  type: "RECEPTIVE",
  userId: 123,
  sectorId: this.sectorId,
  contactId: ctx.contact.id
});
```

#### `resolveField(context: StepContext, fieldPath: string): any`
Resolve field using dot notation.

```typescript
const customerId = this.resolveField(ctx, "contact.customerId");
const campaignType = this.resolveField(ctx, "context.campaignType");
```

#### `resolveParams(context: StepContext, params: any[]): any[]`
Resolve parameters with variable interpolation.

```typescript
const params = this.resolveParams(ctx, [
  "${contact.customerId}",
  "fixed-value",
  123
]);
// Result: [456, "fixed-value", 123]
```

## 📊 StepContext

```typescript
interface StepContext {
  contact: WppContact;              // Contact data
  logger: ProcessingLogger;         // Logger instance
  instance?: string;                // Instance name
  sectorId?: number;                // Sector ID
  customer?: Customer | null;       // Customer data
  [key: string]: any;               // Dynamic properties
}
```

## 🎨 Best Practices

### 1. Keep Steps Small and Focused
Each step should do one thing well.

### 2. Use Configuration
Make steps configurable instead of hardcoding values.

```typescript
// ❌ Bad
const timeout = 5000;

// ✅ Good
const timeout = this.config['timeout'] || 5000;
```

### 3. Always Add Logging
Help debugging and monitoring.

```typescript
async execute(ctx: StepContext): Promise<StepResult> {
  ctx.logger.log("Starting my step...");
  // logic
  ctx.logger.log("Step completed successfully");
  return this.continue(ctx);
}
```

### 4. Handle Errors with Fallback
Use `fallbackStepId` for error recovery.

```typescript
try {
  // risky operation
} catch (error) {
  ctx.logger.log("Error occurred", error);
  // BaseStep.run() will automatically use fallbackStepId
  throw error;
}
```

### 5. Validate Required Config
```typescript
StepRegistry.register("MY_STEP", MyStep, {
  requiredConfig: ["apiKey", "endpoint"],
  optionalConfig: ["timeout", "retries"]
});
```

## 🧪 Testing

```typescript
describe('MyCustomStep', () => {
  it('should execute successfully', async () => {
    const step = new MyCustomStep({
      id: 1,
      instance: 'test',
      sectorId: 1,
      config: { fieldName: 'value' },
      nextStepId: 2
    });

    const context = {
      contact: mockContact,
      logger: mockLogger
    };

    const result = await step.execute(context);
    
    expect(result.isFinal).toBe(false);
    expect(result.stepId).toBe(2);
  });
});
```

## 📚 Additional Documentation

- [Implementation Guide](./GUIA_IMPLEMENTACAO.md) - Detailed implementation guide
- [Complete Examples](./EXEMPLOS_PRATICOS_FLUXOS.md) - Practical flow examples
- [Modernization Guide](./MODERNIZACAO_COMPLETA.md) - System modernization details
- [Implementation Completed](./IMPLEMENTACAO_CONCLUIDA.md) - Current implementation status

## 🔄 Migration from Legacy

If you have old steps using the legacy `Step` interface:

```typescript
// Old
class OldStep implements Step {
  constructor({ instance, sectorId, stepId, nextStepId }) {
    this.instance = instance;
    // ...
  }
  
  async run(ctx): Promise<NextStep | FinalStep> {
    // logic
    return { isFinal: false, stepId: this.nextStepId };
  }
}

// New
class NewStep extends BaseStep {
  constructor(config: StepConfig) {
    super(config);
  }
  
  async execute(ctx: StepContext): Promise<StepResult> {
    // logic
    return this.continue(ctx);
  }
}
```

## 🤝 Contributing

When adding a new step:

1. Create step class extending `BaseStep`
2. Implement `execute()` method
3. Register in `register-steps.ts`
4. Add to this documentation
5. Write tests
6. Update database enum if needed

---

**Last Updated:** October 17, 2025
