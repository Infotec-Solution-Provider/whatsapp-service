# 🚀 Bot Flow Builder - Proposta de Expansão do Message Flow

## 📋 Visão Geral

Transformar o atual **Message Flow** (focado em atribuição de atendentes) em um **Bot Flow Builder** completo que permita criar bots conversacionais complexos totalmente via configuração, sem código.

---

## 🎯 Objetivos

### Atual (Message Flow)
- ✅ Atribui chats a atendentes
- ✅ Steps encadeados (1 → 2 → 3)
- ✅ Contexto compartilhado entre steps
- ✅ Proteção contra loops infinitos

### Novo (Bot Flow Builder)
- ✅ **Criar bots completos via configuração**
- ✅ **Fluxos que chamam sub-fluxos**
- ✅ **State management robusto**
- ✅ **Steps de mensagem interativa**
- ✅ **Validações configuráveis**
- ✅ **Condições e branches complexas**
- ✅ **Integração com APIs externas**
- ✅ **Templates de mensagens**
- ✅ **Editor visual (futuro)**

---

## 🏗️ Arquitetura Proposta

### Estrutura de Dados

```typescript
// Novo schema Prisma
model BotFlow {
  id          Int      @id @default(autoincrement())
  name        String   // "Bot de Vinculação de Cliente"
  description String?
  instance    String
  sectorId    Int?
  version     Int      @default(1)
  isActive    Boolean  @default(true)
  type        FlowType @default(BOT) // BOT, ASSIGNMENT, HYBRID
  
  // Configurações
  config      Json     // { timeoutMs, maxRetries, etc }
  
  // Steps do fluxo
  steps       BotFlowStep[]
  
  // Variáveis globais do fluxo
  variables   BotFlowVariable[]
  
  // Sub-fluxos que podem ser chamados
  subFlows    BotFlow[] @relation("SubFlows")
  parentFlow  BotFlow?  @relation("SubFlows", fields: [parentFlowId], references: [id])
  parentFlowId Int?
  
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  @@map("bot_flows")
}

model BotFlowStep {
  id            Int      @id @default(autoincrement())
  flowId        Int
  stepNumber    Int      // Posição no fluxo
  stepType      String   // SEND_MESSAGE, WAIT_INPUT, VALIDATE, CONDITION, etc
  name          String   // "Solicitar CNPJ"
  description   String?
  
  // Configuração específica do step
  config        Json     // Varia por tipo
  
  // Conexões/Roteamento
  connections   Json     // { onSuccess: 2, onFailure: 5, onTimeout: 10 }
  
  // Ordem de execução
  order         Int
  
  flow          BotFlow  @relation(fields: [flowId], references: [id], onDelete: Cascade)
  
  @@unique([flowId, stepNumber])
  @@map("bot_flow_steps")
}

model BotFlowVariable {
  id          Int      @id @default(autoincrement())
  flowId      Int
  name        String   // "cnpj", "customer_id", "retry_count"
  type        VarType  // STRING, NUMBER, BOOLEAN, OBJECT, ARRAY
  defaultValue Json?
  description String?
  
  flow        BotFlow  @relation(fields: [flowId], references: [id], onDelete: Cascade)
  
  @@unique([flowId, name])
  @@map("bot_flow_variables")
}

model BotFlowExecution {
  id          Int      @id @default(autoincrement())
  flowId      Int
  chatId      Int
  contactId   Int
  
  // Estado atual
  currentStep Int
  status      ExecutionStatus // RUNNING, COMPLETED, FAILED, TIMEOUT
  
  // Armazenamento de estado
  state       Json     // { cnpj: "12345678000190", customer: {...}, etc }
  
  // Histórico de execução
  history     Json[]   // [{ step: 1, timestamp, input, output }]
  
  startedAt   DateTime @default(now())
  completedAt DateTime?
  
  @@map("bot_flow_executions")
}

enum FlowType {
  BOT           // Fluxo de bot conversacional
  ASSIGNMENT    // Fluxo de atribuição (atual)
  HYBRID        // Misto
}

enum VarType {
  STRING
  NUMBER
  BOOLEAN
  OBJECT
  ARRAY
}

enum ExecutionStatus {
  RUNNING
  COMPLETED
  FAILED
  TIMEOUT
  CANCELLED
}
```

---

## 📦 Novos Tipos de Steps

### 1. **SEND_MESSAGE** - Envia mensagem ao usuário

```typescript
// Config
{
  type: "SEND_MESSAGE",
  config: {
    // Texto estático ou com variáveis
    text: "Olá {{contact.name}}, para prosseguir preciso do CNPJ.",
    
    // Ou referência a template
    templateId: "ask_cnpj",
    templateVars: { name: "{{contact.name}}" },
    
    // Opções de formatação
    formatting: {
      bold: ["CNPJ"],
      italic: [],
      monospace: []
    },
    
    // Mídia opcional
    media: {
      type: "image", // image, video, document, audio
      url: "{{variables.qrcode_url}}",
      caption: "Leia o QR Code"
    },
    
    // Botões (WhatsApp Business)
    buttons: [
      { id: "1", text: "Sim, quero continuar" },
      { id: "2", text: "Não, obrigado" }
    ],
    
    // Lista (WhatsApp Business)
    list: {
      buttonText: "Ver opções",
      sections: [
        {
          title: "Setores",
          rows: [
            { id: "vendas", title: "Vendas", description: "..." },
            { id: "suporte", title: "Suporte", description: "..." }
          ]
        }
      ]
    }
  },
  connections: {
    next: 2 // Próximo step sempre
  }
}
```

### 2. **WAIT_INPUT** - Aguarda resposta do usuário

```typescript
{
  type: "WAIT_INPUT",
  config: {
    // Timeout em ms
    timeoutMs: 600000, // 10 min
    
    // Validação inline
    validation: {
      type: "regex", // regex, length, range, custom
      pattern: "^\\d{14}$",
      errorMessage: "CNPJ deve ter 14 dígitos"
    },
    
    // Salvar input em variável
    saveAs: "cnpj",
    
    // Transformações
    transform: "digits_only", // digits_only, uppercase, lowercase, trim
    
    // Retry config
    maxRetries: 3,
    retryMessage: "Resposta inválida. Tente novamente ({{retries}}/3)"
  },
  connections: {
    onValid: 3,      // Input válido
    onInvalid: 2,    // Input inválido (retry)
    onTimeout: 10,   // Timeout
    onMaxRetries: 11 // Excedeu tentativas
  }
}
```

### 3. **VALIDATE** - Validação avançada

```typescript
{
  type: "VALIDATE",
  config: {
    // Validador
    validator: "cnpj", // cnpj, cpf, email, phone, custom
    
    // Ou validação customizada
    custom: {
      script: "return input.length === 14 && !input.match(/^(\\d)\\1{13}$/)",
      language: "javascript"
    },
    
    // Input source
    input: "{{state.cnpj}}",
    
    // Mensagens
    messages: {
      success: "CNPJ válido!",
      failure: "CNPJ inválido: {{error}}"
    }
  },
  connections: {
    onValid: 4,
    onInvalid: 2
  }
}
```

### 4. **CONDITION** - Lógica condicional

```typescript
{
  type: "CONDITION",
  config: {
    // Condições múltiplas
    conditions: [
      {
        // Comparação simples
        left: "{{state.customer_found}}",
        operator: "==", // ==, !=, >, <, >=, <=, contains, in
        right: true,
        goto: 5 // Step para customer encontrado
      },
      {
        // Expressão complexa
        expression: "{{state.retry_count}} >= 3",
        goto: 10 // Transferir para humano
      }
    ],
    
    // Default fallback
    default: 6
  }
}
```

### 5. **SET_STATE** - Gerencia estado

```typescript
{
  type: "SET_STATE",
  config: {
    // Define ou atualiza variáveis
    variables: {
      "cnpj": "{{input}}",
      "retry_count": "{{state.retry_count + 1}}",
      "timestamp": "{{now}}",
      
      // Objetos complexos
      "customer_data": {
        "id": "{{db_result.CODIGO}}",
        "name": "{{db_result.NOME}}",
        "cnpj": "{{db_result.CPF_CNPJ}}"
      },
      
      // Arrays
      "attempts": "{{state.attempts.push(input)}}"
    },
    
    // Operações
    operations: [
      { type: "increment", variable: "counter" },
      { type: "append", variable: "history", value: "{{input}}" },
      { type: "clear", variable: "temp_data" }
    ]
  },
  connections: {
    next: 5
  }
}
```

### 6. **GET_STATE** - Lê estado

```typescript
{
  type: "GET_STATE",
  config: {
    // Busca variáveis
    variables: ["cnpj", "customer_id"],
    
    // Salva em contexto temporário
    saveAs: "current_state",
    
    // Validações
    required: ["cnpj"], // Erro se não existir
    
    // Default values
    defaults: {
      "retry_count": 0,
      "attempts": []
    }
  },
  connections: {
    onSuccess: 3,
    onMissing: 2 // Variável required não encontrada
  }
}
```

### 7. **DATABASE_QUERY** - Consulta BD

```typescript
{
  type: "DATABASE_QUERY",
  config: {
    // Query parametrizada
    query: "SELECT * FROM clientes WHERE CPF_CNPJ = ?",
    params: ["{{state.cnpj}}"],
    
    // Ou query builder
    table: "clientes",
    operation: "select", // select, insert, update, delete
    where: {
      "CPF_CNPJ": "{{state.cnpj}}"
    },
    limit: 1,
    
    // Salvar resultado
    saveAs: "customer",
    
    // Transformações
    transform: {
      "CODIGO": "id",
      "NOME": "name",
      "CPF_CNPJ": "cnpj"
    }
  },
  connections: {
    onFound: 5,    // Encontrou resultado
    onNotFound: 6, // Nenhum resultado
    onError: 10    // Erro na query
  }
}
```

### 8. **API_CALL** - Chama API externa

```typescript
{
  type: "API_CALL",
  config: {
    url: "https://api.example.com/customers",
    method: "POST", // GET, POST, PUT, DELETE
    
    // Headers
    headers: {
      "Authorization": "Bearer {{env.API_TOKEN}}",
      "Content-Type": "application/json"
    },
    
    // Body
    body: {
      "cnpj": "{{state.cnpj}}",
      "source": "whatsapp"
    },
    
    // Timeout
    timeoutMs: 5000,
    
    // Retry config
    retries: 3,
    retryDelay: 1000,
    
    // Salvar resposta
    saveAs: "api_response",
    
    // Extração de dados
    extract: {
      "customer_id": "data.id",
      "customer_name": "data.name"
    }
  },
  connections: {
    onSuccess: 5,  // Status 2xx
    on404: 6,      // Not found
    onError: 10    // Erro de rede/timeout
  }
}
```

### 9. **CALL_SUBFLOW** - Chama sub-fluxo

```typescript
{
  type: "CALL_SUBFLOW",
  config: {
    // Referência ao sub-fluxo
    flowId: 123,
    // Ou nome
    flowName: "validate_cnpj_flow",
    
    // Passar variáveis
    input: {
      "cnpj": "{{state.cnpj}}",
      "instance": "{{context.instance}}"
    },
    
    // Mapear output
    output: {
      "is_valid": "cnpj_valid",
      "customer_data": "customer"
    },
    
    // Timeout do sub-fluxo
    timeoutMs: 30000
  },
  connections: {
    onComplete: 5,  // Sub-fluxo completou
    onFailed: 10,   // Sub-fluxo falhou
    onTimeout: 11   // Sub-fluxo timeout
  }
}
```

### 10. **LOOP** - Iteração

```typescript
{
  type: "LOOP",
  config: {
    // Iterar sobre array
    collection: "{{state.options}}",
    
    // Ou range
    start: 1,
    end: "{{state.max_attempts}}",
    
    // Variável do item
    itemVar: "current_option",
    
    // Variável do índice
    indexVar: "i",
    
    // Steps dentro do loop (sub-flow inline)
    steps: [2, 3, 4], // Steps 2, 3, 4 executam em loop
    
    // Condição de break
    breakWhen: "{{state.found}} == true",
    
    // Max iterations
    maxIterations: 10
  },
  connections: {
    onComplete: 5, // Loop terminou
    onBreak: 6,    // Break condition met
    onMaxIter: 10  // Excedeu max iterations
  }
}
```

### 11. **SWITCH** - Múltiplas condições

```typescript
{
  type: "SWITCH",
  config: {
    // Valor a testar
    value: "{{input}}",
    
    // Cases
    cases: {
      "1": 10,  // Input == "1" → step 10
      "2": 20,  // Input == "2" → step 20
      "3": 30,  // Input == "3" → step 30
    },
    
    // Ou patterns
    patterns: [
      { regex: "^\\d{14}$", goto: 5 },  // CNPJ
      { regex: "^\\d{11}$", goto: 6 },  // CPF
    ],
    
    // Default
    default: 99
  }
}
```

### 12. **ASSIGN_AGENT** - Atribui atendente

```typescript
{
  type: "ASSIGN_AGENT",
  config: {
    // Estratégia
    strategy: "least_busy", // least_busy, round_robin, specific, random
    
    // Filtros
    filter: {
      sectorId: "{{context.sectorId}}",
      online: true,
      skills: ["sales", "vip"]
    },
    
    // Ou atendente específico
    userId: "{{state.preferred_agent}}",
    
    // Fallback
    fallbackToAdmin: true,
    
    // Mensagem de transferência
    message: "Transferindo para {{agent.name}}..."
  },
  connections: {
    onAssigned: 5,  // Atribuído
    onNoAgent: 10   // Nenhum agente disponível
  }
}
```

### 13. **UPDATE_CONTACT** - Atualiza contato

```typescript
{
  type: "UPDATE_CONTACT",
  config: {
    // Campos a atualizar
    updates: {
      customerId: "{{state.customer_id}}",
      name: "{{state.customer_name}}",
      // Campos customizados
      customFields: {
        "verified": true,
        "last_purchase": "{{now}}"
      }
    }
  },
  connections: {
    next: 5
  }
}
```

### 14. **UPDATE_CHAT** - Atualiza chat

```typescript
{
  type: "UPDATE_CHAT",
  config: {
    updates: {
      botId: null,  // Remove bot
      userId: "{{state.assigned_user}}",
      priority: "HIGH",
      tags: ["vip", "urgent"]
    }
  },
  connections: {
    next: 5
  }
}
```

### 15. **FINISH_FLOW** - Finaliza fluxo

```typescript
{
  type: "FINISH_FLOW",
  config: {
    // Tipo de finalização
    result: "success", // success, failure, transfer
    
    // Dados de retorno (para sub-fluxos)
    output: {
      "customer_linked": true,
      "customer_id": "{{state.customer_id}}"
    },
    
    // Chat payload (para fluxos bot)
    chatData: {
      instance: "{{context.instance}}",
      type: "RECEPTIVE",
      userId: "{{state.user_id}}",
      sectorId: "{{context.sectorId}}",
      contactId: "{{context.contact.id}}",
      systemMessage: "Cliente vinculado com sucesso!"
    },
    
    // Ações pós-finalização
    postActions: [
      { type: "send_webhook", url: "..." },
      { type: "log_event", event: "customer_linked" }
    ]
  }
}
```

### 16. **PARALLEL** - Execução paralela

```typescript
{
  type: "PARALLEL",
  config: {
    // Steps executados em paralelo
    branches: [
      { name: "check_stock", steps: [10, 11, 12] },
      { name: "check_credit", steps: [20, 21, 22] },
      { name: "notify_team", steps: [30, 31] }
    ],
    
    // Estratégia de continuação
    waitFor: "all", // all, any, none (fire-and-forget)
    
    // Timeout
    timeoutMs: 10000
  },
  connections: {
    onComplete: 5,  // Todas branches completaram
    onPartial: 6,   // Algumas completaram (se waitFor: any)
    onTimeout: 10   // Timeout
  }
}
```

### 17. **DELAY** - Atraso temporal

```typescript
{
  type: "DELAY",
  config: {
    // Delay em ms
    delayMs: 2000,
    
    // Ou dinâmico
    delayMs: "{{state.wait_time}}",
    
    // Mensagem opcional durante espera
    message: "Processando...",
    
    // Cancelável?
    cancellable: true
  },
  connections: {
    next: 5
  }
}
```

### 18. **LOG** - Logging

```typescript
{
  type: "LOG",
  config: {
    level: "info", // debug, info, warn, error
    message: "Customer {{state.customer_id}} linked successfully",
    
    // Dados estruturados
    data: {
      customerId: "{{state.customer_id}}",
      cnpj: "{{state.cnpj}}",
      timestamp: "{{now}}"
    },
    
    // Enviar para analytics
    analytics: true
  },
  connections: {
    next: 5
  }
}
```

### 19. **ERROR_HANDLER** - Tratamento de erros

```typescript
{
  type: "ERROR_HANDLER",
  config: {
    // Captura erros de steps anteriores
    catchFrom: [3, 4, 5],
    
    // Tipos de erro
    catch: ["DatabaseError", "ValidationError", "TimeoutError"],
    
    // Ações
    actions: [
      {
        type: "log_error",
        data: "{{error}}"
      },
      {
        type: "send_message",
        text: "Ocorreu um erro. Transferindo para atendente..."
      },
      {
        type: "notify_admin",
        channel: "slack"
      }
    ],
    
    // Retry?
    retry: {
      attempts: 3,
      delayMs: 1000,
      backoff: "exponential"
    }
  },
  connections: {
    onHandled: 10,  // Erro tratado
    onRetry: 3,     // Tentar novamente
    onGiveUp: 99    // Desistir
  }
}
```

### 20. **CUSTOM_CODE** - Código customizado

```typescript
{
  type: "CUSTOM_CODE",
  config: {
    // JavaScript isolado
    code: `
      const customer = state.customer;
      const score = calculateScore(customer);
      
      return {
        score,
        category: score > 80 ? 'VIP' : 'REGULAR'
      };
    `,
    
    // Ou referência a função
    function: "calculateCustomerScore",
    
    // Parâmetros
    params: {
      customer: "{{state.customer}}",
      history: "{{state.purchase_history}}"
    },
    
    // Timeout
    timeoutMs: 5000,
    
    // Salvar resultado
    saveAs: "score_data"
  },
  connections: {
    next: 5,
    onError: 10
  }
}
```

---

## 🔄 Fluxos Compostos - Sub-Flows

### Exemplo: Bot de Vinculação usando Sub-Flows

```json
{
  "name": "Bot de Vinculação de Cliente",
  "type": "BOT",
  "steps": [
    {
      "stepNumber": 1,
      "type": "SEND_MESSAGE",
      "config": {
        "text": "Para prosseguir, preciso do CNPJ da sua empresa."
      },
      "connections": { "next": 2 }
    },
    {
      "stepNumber": 2,
      "type": "CALL_SUBFLOW",
      "name": "Validar e Buscar Cliente por CNPJ",
      "config": {
        "flowName": "validate_and_find_customer",
        "input": {
          "instance": "{{context.instance}}"
        },
        "output": {
          "customer": "customer_data",
          "found": "customer_found"
        }
      },
      "connections": {
        "onComplete": 3,
        "onFailed": 10
      }
    },
    {
      "stepNumber": 3,
      "type": "CONDITION",
      "config": {
        "conditions": [
          {
            "left": "{{state.customer_found}}",
            "operator": "==",
            "right": true,
            "goto": 4
          }
        ],
        "default": 8
      }
    },
    {
      "stepNumber": 4,
      "type": "UPDATE_CONTACT",
      "config": {
        "updates": {
          "customerId": "{{state.customer_data.id}}"
        }
      },
      "connections": { "next": 5 }
    },
    {
      "stepNumber": 5,
      "type": "SEND_MESSAGE",
      "config": {
        "text": "Cliente {{state.customer_data.name}} vinculado com sucesso!"
      },
      "connections": { "next": 6 }
    },
    {
      "stepNumber": 6,
      "type": "FINISH_FLOW",
      "config": {
        "result": "success"
      }
    },
    {
      "stepNumber": 8,
      "type": "SEND_MESSAGE",
      "config": {
        "text": "Cliente não encontrado. Você será direcionado para atendimento humano."
      },
      "connections": { "next": 9 }
    },
    {
      "stepNumber": 9,
      "type": "ASSIGN_AGENT",
      "config": {
        "strategy": "least_busy"
      },
      "connections": { "next": 10 }
    },
    {
      "stepNumber": 10,
      "type": "FINISH_FLOW",
      "config": {
        "result": "transfer"
      }
    }
  ]
}
```

### Sub-Flow: Validar e Buscar Cliente

```json
{
  "name": "validate_and_find_customer",
  "type": "BOT",
  "steps": [
    {
      "stepNumber": 1,
      "type": "WAIT_INPUT",
      "config": {
        "timeoutMs": 600000,
        "saveAs": "cnpj_input",
        "maxRetries": 3
      },
      "connections": {
        "onValid": 2,
        "onTimeout": 99,
        "onMaxRetries": 99
      }
    },
    {
      "stepNumber": 2,
      "type": "VALIDATE",
      "config": {
        "validator": "cnpj",
        "input": "{{state.cnpj_input}}"
      },
      "connections": {
        "onValid": 3,
        "onInvalid": 10
      }
    },
    {
      "stepNumber": 3,
      "type": "SET_STATE",
      "config": {
        "variables": {
          "cnpj": "{{state.cnpj_input}}"
        }
      },
      "connections": { "next": 4 }
    },
    {
      "stepNumber": 4,
      "type": "DATABASE_QUERY",
      "config": {
        "query": "SELECT * FROM clientes WHERE CPF_CNPJ = ?",
        "params": ["{{state.cnpj}}"],
        "saveAs": "customer"
      },
      "connections": {
        "onFound": 5,
        "onNotFound": 6
      }
    },
    {
      "stepNumber": 5,
      "type": "FINISH_FLOW",
      "config": {
        "result": "success",
        "output": {
          "customer": "{{state.customer}}",
          "found": true
        }
      }
    },
    {
      "stepNumber": 6,
      "type": "FINISH_FLOW",
      "config": {
        "result": "success",
        "output": {
          "found": false
        }
      }
    },
    {
      "stepNumber": 10,
      "type": "SEND_MESSAGE",
      "config": {
        "text": "CNPJ inválido. Tente novamente."
      },
      "connections": { "next": 1 }
    },
    {
      "stepNumber": 99,
      "type": "FINISH_FLOW",
      "config": {
        "result": "failure"
      }
    }
  ]
}
```

---

## 🎨 Editor Visual (Futuro)

### Interface Web
```
┌────────────────────────────────────────────────────┐
│  Bot Flow Builder - Customer Linking Bot          │
├────────────────────────────────────────────────────┤
│                                                     │
│  [Toolbox]              [Canvas]                   │
│  ┌──────────┐          ┌──────────────┐           │
│  │ Messages │          │   START      │           │
│  │ • Send   │          └──────┬───────┘           │
│  │ • Wait   │                 │                   │
│  │          │          ┌──────▼───────┐           │
│  │ Logic    │          │ Send Message │           │
│  │ • Cond.  │          │ "Ask CNPJ"   │           │
│  │ • Switch │          └──────┬───────┘           │
│  │ • Loop   │                 │                   │
│  │          │          ┌──────▼───────┐           │
│  │ Data     │          │ Wait Input   │◄──┐       │
│  │ • Query  │          │ Save: cnpj   │   │       │
│  │ • API    │          └──────┬───────┘   │       │
│  │ • State  │             ┌───┴───┐       │       │
│  │          │         valid│  invalid      │       │
│  │ Actions  │              │       │       │       │
│  │ • Assign │       ┌──────▼─┐  ┌─▼───────┴┐     │
│  │ • Update │       │ DB Query  │ Send Error│     │
│  │ • Finish │       └──┬──┬───┘ └───────────┘     │
│  └──────────┘      found│ │not                    │
│                          │ │                       │
│                   ┌──────▼─▼──────┐               │
│                   │   Condition    │               │
│                   └───┬────────┬───┘               │
│                   true│    false│                  │
│                       │         │                  │
│                ┌──────▼──┐  ┌───▼──────┐          │
│                │ Link    │  │ Transfer │          │
│                │Customer │  │ to Human │          │
│                └─────┬───┘  └─────┬────┘          │
│                      │            │               │
│                ┌─────▼────────────▼─┐             │
│                │      FINISH         │             │
│                └─────────────────────┘             │
│                                                     │
└────────────────────────────────────────────────────┘
```

---

## 🔧 Implementação - Classes Base

### BotFlowEngine

```typescript
// src/bot-flow/bot-flow-engine.ts
export class BotFlowEngine {
  private flowLoader: FlowLoader;
  private stepExecutor: StepExecutor;
  private stateManager: StateManager;
  private executionTracker: ExecutionTracker;
  
  async executeFlow(
    flowId: number,
    context: FlowContext
  ): Promise<FlowResult> {
    // 1. Carregar flow
    const flow = await this.flowLoader.load(flowId);
    
    // 2. Inicializar estado
    const execution = await this.stateManager.initialize(flow, context);
    
    // 3. Executar steps
    let currentStep = 1;
    while (currentStep) {
      const step = flow.steps.find(s => s.stepNumber === currentStep);
      if (!step) break;
      
      const result = await this.stepExecutor.execute(step, execution);
      
      // Salvar histórico
      await this.executionTracker.track(execution.id, step, result);
      
      // Atualizar estado
      await this.stateManager.update(execution.id, result.state);
      
      if (result.isFinish) {
        return result;
      }
      
      currentStep = result.nextStep;
    }
    
    throw new Error('Flow ended without FINISH step');
  }
  
  async executeSubFlow(
    parentExecutionId: number,
    subFlowId: number,
    input: Record<string, any>
  ): Promise<Record<string, any>> {
    // Executa sub-flow e retorna output
    const context = await this.createSubFlowContext(
      parentExecutionId,
      input
    );
    
    const result = await this.executeFlow(subFlowId, context);
    return result.output;
  }
}
```

### StateManager

```typescript
// src/bot-flow/state-manager.ts
export class StateManager {
  async get(executionId: number, variable: string): Promise<any> {
    const execution = await prisma.botFlowExecution.findUnique({
      where: { id: executionId }
    });
    
    const state = execution.state as Record<string, any>;
    return state[variable];
  }
  
  async set(
    executionId: number,
    variable: string,
    value: any
  ): Promise<void> {
    await prisma.botFlowExecution.update({
      where: { id: executionId },
      data: {
        state: {
          // Merge com estado existente
          ...existing,
          [variable]: value
        }
      }
    });
  }
  
  async getAll(executionId: number): Promise<Record<string, any>> {
    const execution = await prisma.botFlowExecution.findUnique({
      where: { id: executionId }
    });
    
    return execution.state as Record<string, any>;
  }
  
  async setMultiple(
    executionId: number,
    variables: Record<string, any>
  ): Promise<void> {
    await prisma.botFlowExecution.update({
      where: { id: executionId },
      data: {
        state: {
          ...existing,
          ...variables
        }
      }
    });
  }
}
```

### Template Engine

```typescript
// src/bot-flow/template-engine.ts
export class TemplateEngine {
  private state: Record<string, any>;
  private context: Record<string, any>;
  
  parse(template: string): any {
    // Suporta:
    // - {{variable}}
    // - {{object.property}}
    // - {{array[0]}}
    // - {{function(arg1, arg2)}}
    // - {{state.count + 1}}
    
    return template.replace(/\{\{(.*?)\}\}/g, (match, expr) => {
      return this.evaluate(expr);
    });
  }
  
  private evaluate(expression: string): any {
    // Implementação simplificada
    // Produção: usar parser mais robusto
    
    // Acesso a propriedades: state.cnpj
    if (expression.includes('.')) {
      const parts = expression.split('.');
      let value = this.getRoot(parts[0]);
      
      for (let i = 1; i < parts.length; i++) {
        value = value?.[parts[i]];
      }
      
      return value;
    }
    
    // Expressões: state.count + 1
    if (/[+\-*\/]/.test(expression)) {
      // Usar eval com sanitização
      return this.evaluateExpression(expression);
    }
    
    // Variável simples
    return this.getRoot(expression);
  }
  
  private getRoot(name: string): any {
    if (name.startsWith('state.')) {
      return this.state;
    }
    if (name.startsWith('context.')) {
      return this.context;
    }
    // env, functions, etc
    return undefined;
  }
}
```

---

## 📊 Métricas e Analytics

```typescript
// Analytics automático
{
  flowId: 123,
  executions: {
    total: 1000,
    completed: 850,
    failed: 50,
    timeout: 100
  },
  
  steps: {
    1: { executions: 1000, avgDuration: 120 },
    2: { executions: 950, avgDuration: 5000 }, // Wait input
    3: { executions: 900, avgDuration: 200 }
  },
  
  branches: {
    "step_3_onValid": 800,   // 80% válidos
    "step_3_onInvalid": 100  // 10% inválidos
  },
  
  avgCompletionTime: 45000, // 45s
  conversionRate: 0.85      // 85%
}
```

---

## 🚀 Benefícios

### Para Desenvolvedores
- ✅ **Criar bots sem código**
- ✅ **Reutilizar sub-fluxos**
- ✅ **Debugging visual**
- ✅ **Versionamento de fluxos**
- ✅ **Testes automatizados**

### Para Negócio
- ✅ **Time-to-market menor**
- ✅ **Personalização por cliente**
- ✅ **A/B testing de fluxos**
- ✅ **Analytics detalhado**
- ✅ **ROI mensurável**

### Para Usuários Finais
- ✅ **Respostas mais rápidas**
- ✅ **Fluxos personalizados**
- ✅ **Menos erros**
- ✅ **Experiência consistente**

---

## 📅 Roadmap de Implementação

### Fase 1: Foundation (2 semanas)
- [ ] Schema Prisma completo
- [ ] BotFlowEngine básico
- [ ] StateManager
- [ ] TemplateEngine
- [ ] Steps básicos (SEND, WAIT, CONDITION)

### Fase 2: Core Steps (2 semanas)
- [ ] DATABASE_QUERY
- [ ] API_CALL
- [ ] VALIDATE
- [ ] SET/GET_STATE
- [ ] CALL_SUBFLOW

### Fase 3: Advanced Steps (1 semana)
- [ ] LOOP
- [ ] PARALLEL
- [ ] ERROR_HANDLER
- [ ] CUSTOM_CODE

### Fase 4: Integration (1 semana)
- [ ] Integrar com messages-distribution
- [ ] Migrar bots existentes
- [ ] Testes end-to-end

### Fase 5: UI (3 semanas)
- [ ] Editor visual drag-and-drop
- [ ] Flow debugger
- [ ] Analytics dashboard
- [ ] Template library

---

## 🎓 Conclusão

Esta proposta transforma o Message Flow em um **sistema completo de automação conversacional**, permitindo:

1. **Criar qualquer bot** via configuração
2. **Composição de fluxos** (sub-flows)
3. **Estado persistente** robusto
4. **20+ tipos de steps** prontos
5. **Editor visual** intuitivo
6. **Analytics** integrado

**ROI Estimado:**
- Criação de bots: **10x mais rápido**
- Manutenção: **5x mais fácil**
- Bugs: **-80%**
- Time-to-market: **-70%**

**Próximo Passo:** Criar POC com steps básicos usando um bot simples! 🚀
