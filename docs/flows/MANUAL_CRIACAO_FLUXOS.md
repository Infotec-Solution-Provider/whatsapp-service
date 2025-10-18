# 📘 Manual de Criação de Fluxos de Mensagens

## 🎯 Visão Geral

Este manual explica como criar fluxos personalizados de distribuição de mensagens no banco de dados. Os fluxos permitem criar lógicas customizadas para cada instância e setor, controlando como os chats são distribuídos para usuários, carteiras ou admin.

## 📊 Estrutura do Banco de Dados

### Tabela: `message_flows`

```sql
CREATE TABLE message_flows (
    id INT PRIMARY KEY AUTO_INCREMENT,
    instance VARCHAR(255) NOT NULL,
    sector_id INT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (instance, sector_id)
);
```

**Campos:**
- `instance`: Nome da instância (ex: "karsten", "vollo")
- `sector_id`: ID do setor
- `description`: Descrição opcional do fluxo
- **IMPORTANTE**: A combinação `(instance, sector_id)` é única

### Tabela: `message_flows_steps`

```sql
CREATE TABLE message_flows_steps (
    id INT PRIMARY KEY AUTO_INCREMENT,
    message_flow_id INT NOT NULL,
    type VARCHAR(100) NOT NULL,
    step_number INT NOT NULL,
    config JSON,
    next_step_id INT,
    fallback_step_id INT,
    enabled BOOLEAN DEFAULT TRUE,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (message_flow_id, step_number),
    FOREIGN KEY (message_flow_id) REFERENCES message_flows(id) ON DELETE CASCADE
);
```

**Campos:**
- `message_flow_id`: ID do fluxo pai
- `type`: Tipo do step (ver enum `WppMessageFlowStepType`)
- `step_number`: Número sequencial do step (1, 2, 3...)
- `config`: Configuração JSON específica do step
- `next_step_id`: **Número do próximo step** (permite fluxos não-lineares)
- `fallback_step_id`: **Número do step alternativo** em caso de erro
- `enabled`: Se o step está ativo (padrão: true)
- `description`: Descrição opcional do step

## 🔢 Como Funciona o Fluxo

### Conceitos Importantes

1. **Step Number**: Posição/identificador único do step no fluxo (1, 2, 3, 4...)
2. **Next Step ID**: Para qual step o fluxo deve ir após este step
3. **Fallback Step ID**: Para qual step ir em caso de erro neste step
4. **Fluxos Lineares**: `next_step_id` incrementa sequencialmente (1→2→3→4)
5. **Fluxos Não-Lineares**: `next_step_id` pode pular ou voltar (1→3→2→5)

### Exemplo Visual

```
┌─────────────┐
│   Step #1   │ next_step_id = 2
│ CHECK_ADMIN │ fallback_step_id = 5
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Step #2   │ next_step_id = 3
│CHECK_LOYALTY│ fallback_step_id = 4
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Step #3   │ next_step_id = 5
│CHECK_USERS  │ fallback_step_id = 4
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Step #4   │ next_step_id = NULL (finaliza)
│SEND_TO_ADMIN│ fallback_step_id = NULL
└─────────────┘

┌─────────────┐
│   Step #5   │ next_step_id = NULL (finaliza)
│  ASSIGN     │ (step alternativo)
└─────────────┘
```

## 📝 Passo a Passo: Criar um Fluxo

### 1. Criar o Fluxo Principal

```sql
INSERT INTO message_flows (instance, sector_id, description)
VALUES ('karsten', 1, 'Fluxo customizado para distribuição de chats');
```

Isso retorna um `id`, por exemplo: `123`

### 2. Adicionar Steps ao Fluxo

#### Exemplo: Fluxo Linear Simples

```sql
-- Step 1: Verifica se é admin
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    fallback_step_id,
    description
) VALUES (
    123,                    -- ID do fluxo criado
    'CHECK_ONLY_ADMIN',     -- Tipo do step
    1,                      -- Número do step
    2,                      -- Próximo step
    NULL,                   -- Sem fallback
    'Verifica se contato é apenas admin'
);

-- Step 2: Verifica fidelização
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    fallback_step_id,
    description
) VALUES (
    123,
    'CHECK_LOALTY',
    2,
    3,                      -- Vai para step 3
    NULL,
    'Verifica campanha de fidelização'
);

-- Step 3: Verifica usuários disponíveis
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    fallback_step_id,
    description
) VALUES (
    123,
    'CHECK_AVAILABLE_USERS',
    3,
    4,                      -- Vai para step 4
    NULL,
    'Busca usuários online no setor'
);

-- Step 4: Envia para admin (step final)
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    fallback_step_id,
    description
) VALUES (
    123,
    'SEND_TO_ADMIN',
    4,
    NULL,                   -- NULL = finaliza o fluxo
    NULL,
    'Envia para o admin como última opção'
);
```

#### Exemplo: Fluxo com Condições e Ramificações

```sql
-- Step 1: Query para buscar tipo de cliente
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    config,
    description
) VALUES (
    123,
    'QUERY',
    1,
    2,                      -- Vai para step 2 (router)
    JSON_OBJECT(
        'query', 'SELECT tipo FROM clientes WHERE codigo = ?',
        'params', JSON_ARRAY('${contact.customerId}'),
        'storeAs', 'customerType',
        'single', true
    ),
    'Busca tipo do cliente'
);

-- Step 2: Router baseado no tipo de cliente
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    config,
    description
) VALUES (
    123,
    'ROUTER',
    2,
    5,                      -- Default: vai para step 5
    JSON_OBJECT(
        'field', 'customerType.tipo',
        'routes', JSON_OBJECT(
            'VIP', 3,       -- Tipo VIP vai para step 3
            'PREMIUM', 4    -- Tipo PREMIUM vai para step 4
        ),
        'default', 5        -- Outros tipos vão para step 5
    ),
    'Roteia baseado no tipo de cliente'
);

-- Step 3: Assign para usuário VIP
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    config,
    description
) VALUES (
    123,
    'ASSIGN',
    3,
    NULL,                   -- Finaliza
    JSON_OBJECT(
        'userId', 10,       -- Usuário específico para VIP
        'priority', 'HIGH',
        'systemMessage', 'Cliente VIP: ${customerType.nome}'
    ),
    'Atribui cliente VIP para usuário específico'
);

-- Step 4: Assign para carteira Premium
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    config,
    description
) VALUES (
    123,
    'ASSIGN',
    4,
    NULL,                   -- Finaliza
    JSON_OBJECT(
        'walletId', 5,      -- Carteira Premium
        'priority', 'MEDIUM'
    ),
    'Atribui cliente Premium para carteira'
);

-- Step 5: Fluxo padrão (check users)
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    fallback_step_id,
    description
) VALUES (
    123,
    'CHECK_AVAILABLE_USERS',
    5,
    NULL,                   -- Finaliza se encontrar
    6,                      -- Fallback para step 6
    'Busca usuários disponíveis'
);

-- Step 6: Fallback - envia para admin
INSERT INTO message_flows_steps (
    message_flow_id,
    type,
    step_number,
    next_step_id,
    description
) VALUES (
    123,
    'SEND_TO_ADMIN',
    6,
    NULL,                   -- Finaliza
    'Fallback: envia para admin'
);
```

## 🎨 Tipos de Steps Disponíveis

### Steps Específicos (Pré-construídos)

| Tipo | Descrição | Finaliza? | Config |
|------|-----------|-----------|--------|
| `CHECK_ONLY_ADMIN` | Verifica se contato é apenas admin | Sim (se true) | - |
| `CHECK_LOALTY` | Verifica fidelização/campanha | Sim (se encontrar) | - |
| `CHECK_AVAILABLE_USERS` | Busca usuários online | Sim (se encontrar) | - |
| `SEND_TO_ADMIN` | Envia para admin | Sim | - |
| `SEND_TO_SECTOR_USER` | Envia para usuário do setor | Sim | `preferAdmin` (bool) |

### Steps Genéricos (Configuráveis)

| Tipo | Descrição | Config Obrigatória |
|------|-----------|-------------------|
| `QUERY` | Executa query SQL | `query`, `storeAs` |
| `CONDITION` | Avalia condição | `field`, `operator`, `value`, `onTrue`, `onFalse` |
| `ROUTER` | Roteia baseado em valor | `field`, `routes` |
| `ASSIGN` | Atribui chat | `userId` ou `walletId` |

## 🔧 Configurações dos Steps (JSON)

### QUERY

```json
{
  "query": "SELECT * FROM tabela WHERE campo = ?",
  "params": ["${contact.customerId}"],
  "storeAs": "nomeVariavel",
  "single": true,
  "required": false
}
```

### CONDITION

```json
{
  "field": "contact.isOnlyAdmin",
  "operator": "equals",
  "value": true,
  "onTrue": 3,
  "onFalse": 4
}
```

**Operadores**: `equals`, `notEquals`, `contains`, `in`, `gt`, `gte`, `lt`, `lte`, `exists`, `notExists`, `regex`, `between`

### ROUTER

```json
{
  "field": "customerType.tipo",
  "routes": {
    "VIP": 3,
    "PREMIUM": 4,
    "REGULAR": 5
  },
  "default": 6
}
```

### ASSIGN

```json
{
  "userId": 10,
  "walletId": 5,
  "priority": "HIGH",
  "systemMessage": "Cliente ${customer.NOME}",
  "type": "RECEPTIVE"
}
```

## ⚠️ Regras Importantes

### 1. Step Numbers Únicos
```sql
-- ❌ ERRADO: step_number duplicado
INSERT INTO message_flows_steps (message_flow_id, step_number, ...) VALUES (1, 1, ...);
INSERT INTO message_flows_steps (message_flow_id, step_number, ...) VALUES (1, 1, ...);

-- ✅ CORRETO: step_number único por fluxo
INSERT INTO message_flows_steps (message_flow_id, step_number, ...) VALUES (1, 1, ...);
INSERT INTO message_flows_steps (message_flow_id, step_number, ...) VALUES (1, 2, ...);
```

### 2. Next Step ID deve existir
```sql
-- Se next_step_id = 3, deve existir um step com step_number = 3
INSERT INTO message_flows_steps (..., step_number, next_step_id, ...)
VALUES (..., 1, 3, ...);  -- Step 3 DEVE existir!
```

### 3. Steps Finais
```sql
-- Steps que finalizam o fluxo devem ter next_step_id = NULL
INSERT INTO message_flows_steps (..., next_step_id, ...)
VALUES (..., NULL, ...);  -- Finaliza aqui
```

### 4. Fluxo deve começar em 1
```sql
-- O fluxo SEMPRE começa no step_number = 1
-- Deve existir pelo menos um step com step_number = 1
INSERT INTO message_flows_steps (..., step_number, ...)
VALUES (..., 1, ...);  -- Obrigatório!
```

## 📋 Template SQL Completo

```sql
-- 1. Criar o fluxo
INSERT INTO message_flows (instance, sector_id, description)
VALUES ('minha_instancia', 1, 'Descrição do fluxo');

-- Guarde o ID retornado, ex: 999

-- 2. Adicionar steps
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, 
    fallback_step_id, config, enabled, description
) VALUES
-- Step 1: Início obrigatório
(999, 'CHECK_ONLY_ADMIN', 1, 2, NULL, NULL, true, 'Verifica admin'),
-- Step 2: Intermediário
(999, 'CHECK_LOALTY', 2, 3, NULL, NULL, true, 'Verifica fidelização'),
-- Step 3: Intermediário
(999, 'CHECK_AVAILABLE_USERS', 3, 4, NULL, NULL, true, 'Busca usuários'),
-- Step 4: Final
(999, 'SEND_TO_ADMIN', 4, NULL, NULL, NULL, true, 'Fallback admin');
```

## 🔍 Consultas Úteis

### Ver todos os fluxos
```sql
SELECT 
    mf.id,
    mf.instance,
    mf.sector_id,
    mf.description,
    COUNT(mfs.id) as total_steps
FROM message_flows mf
LEFT JOIN message_flows_steps mfs ON mf.id = mfs.message_flow_id
GROUP BY mf.id;
```

### Ver steps de um fluxo específico
```sql
SELECT 
    step_number,
    type,
    next_step_id,
    fallback_step_id,
    enabled,
    description
FROM message_flows_steps
WHERE message_flow_id = 123
ORDER BY step_number;
```

### Verificar integridade do fluxo
```sql
-- Verifica se todos os next_step_id existem
SELECT 
    mfs1.step_number as from_step,
    mfs1.next_step_id,
    CASE 
        WHEN mfs2.step_number IS NULL AND mfs1.next_step_id IS NOT NULL 
        THEN 'ERRO: Step não encontrado!'
        ELSE 'OK'
    END as status
FROM message_flows_steps mfs1
LEFT JOIN message_flows_steps mfs2 
    ON mfs1.message_flow_id = mfs2.message_flow_id 
    AND mfs1.next_step_id = mfs2.step_number
WHERE mfs1.message_flow_id = 123;
```

## 🚀 Testando o Fluxo

Após criar o fluxo no banco:

1. Reinicie o serviço para carregar o novo fluxo
2. Envie uma mensagem para a instância/setor configurado
3. Verifique os logs para ver a execução:

```
[MessageFlow] === Mapa de Etapas Registradas ===
[MessageFlow] Total de etapas: 4
[MessageFlow] Etapa #1 -> CheckOnlyAdminStep
[MessageFlow] Etapa #2 -> CheckLoaltyStep
[MessageFlow] Etapa #3 -> CheckAvailableUsersStep
[MessageFlow] Etapa #4 -> SendToAdminStep
[MessageFlow] ===============================

[MessageFlow] Iteração 1 - Tentando executar etapa #1
[Step #1] Iniciando execução: CheckOnlyAdminStep
...
```

## 💡 Exemplos de Casos de Uso

### Caso 1: Priorizar Usuário Específico

```sql
INSERT INTO message_flows_steps (message_flow_id, type, step_number, next_step_id, config)
VALUES (
    123,
    'CONDITION',
    1,
    NULL,
    JSON_OBJECT(
        'field', 'contact.customerId',
        'operator', 'in',
        'value', JSON_ARRAY(100, 200, 300),
        'onTrue', 2,
        'onFalse', 3
    )
);

INSERT INTO message_flows_steps (message_flow_id, type, step_number, next_step_id, config)
VALUES (
    123,
    'ASSIGN',
    2,
    NULL,
    JSON_OBJECT('userId', 10, 'priority', 'HIGH')
);
```

### Caso 2: Rotear por Horário

```sql
-- Usar QUERY para pegar hora atual
INSERT INTO message_flows_steps (message_flow_id, type, step_number, next_step_id, config)
VALUES (
    123,
    'QUERY',
    1,
    2,
    JSON_OBJECT(
        'query', 'SELECT HOUR(NOW()) as hora',
        'storeAs', 'horario',
        'single', true
    )
);

-- Rotear baseado na hora
INSERT INTO message_flows_steps (message_flow_id, type, step_number, next_step_id, config)
VALUES (
    123,
    'ROUTER',
    2,
    4,
    JSON_OBJECT(
        'field', 'horario.hora',
        'routes', JSON_OBJECT(
            '8', 3,
            '9', 3,
            '18', 4,
            '19', 4
        ),
        'default', 3
    )
);
```

## 📚 Próximos Passos

- [Documentação dos Steps](./STEPS_DOCUMENTATION.md)
- [Exemplos Práticos](./EXEMPLOS_PRATICOS_FLUXOS.md)
- [Troubleshooting](./TROUBLESHOOTING_FLUXOS.md)
