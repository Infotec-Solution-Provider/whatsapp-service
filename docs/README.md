# 📚 Message Flow System - Documentation

## 🎯 Overview

Sistema de fluxo de mensagens baseado em **Chain of Responsibility Pattern** com arquitetura moderna e extensível.

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
| `ASSIGN` | Direct chat assignment | `userId`, `walletId`, `priority`, `systemMessage`, `type` |

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

#### `interpolateString(context: StepContext, template: string): string`
Interpolate a string replacing all occurrences of `${field.path}`.

```typescript
const message = this.interpolateString(ctx, 
  "📅 Cliente: ${customer.NOME} (${customer.CODIGO})"
);
// Result: "📅 Cliente: João Silva (12345)"

// Multiple interpolations in systemMessage
const systemMsg = this.interpolateString(ctx,
  "Cliente é de AGENDA PÚBLICA.\n\nCliente: ${customer.NOME} (${customer.CODIGO})\nOperador: ${operator.NOME}"
);
```

**Usage in ASSIGN step:**

```json
{
  "type": "ASSIGN",
  "config": {
    "userId": -1,
    "systemMessage": "📅 Cliente: ${customer.NOME} (${customer.CODIGO})\nAtribuindo para supervisão."
  }
}
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
