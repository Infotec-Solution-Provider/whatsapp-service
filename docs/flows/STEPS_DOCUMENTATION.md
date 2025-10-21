# 📚 Documentação Completa dos Steps

## 🎯 Visão Geral

Este documento detalha todos os steps disponíveis no sistema de fluxos de mensagens, incluindo steps específicos (pré-construídos) e steps genéricos (configuráveis).

---

## 📦 Steps Específicos (Pré-construídos)

Estes steps têm lógica fixa e são otimizados para casos de uso comuns.

### 1. CHECK_ONLY_ADMIN

**Descrição**: Verifica se o contato é marcado como "apenas admin" e cria um chat receptivo para o admin.

**Tipo**: `CHECK_ONLY_ADMIN`

**Quando Usar**: Como primeiro step do fluxo para separar contatos administrativos.

**Comportamento**:
- ✅ Se `contact.isOnlyAdmin === true`: Finaliza e cria chat para admin (userId = -1)
- ❌ Se `contact.isOnlyAdmin === false`: Continua para o próximo step

**Configuração**: Não requer configuração

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, description
) VALUES (
    1, 'CHECK_ONLY_ADMIN', 1, 2, 'Separa contatos administrativos'
);
```

**Resultado**:
```typescript
{
    instance: "karsten",
    type: "RECEPTIVE",
    userId: -1,              // Admin
    sectorId: 1,
    contactId: 123
}
```

**Log Example**:
```
[Step #1] Iniciando execução: CheckOnlyAdminStep
Verificando se o contato é apenas administrador...
O contato é apenas administrador.
Chat criado. { instance: 'karsten', type: 'RECEPTIVE', userId: -1, ... }
[Step #1] Finalizou com chat
```

---

### 2. CHECK_LOALTY (CHECK_LOYALTY)

**Descrição**: Verifica se o cliente possui uma campanha de fidelização ativa e atribui ao operador da campanha.

**Tipo**: `CHECK_LOALTY`

**Quando Usar**: Para manter fidelização cliente-vendedor em programas de relacionamento.

**Comportamento**:
1. Busca última campanha do cliente na tabela `campanhas_clientes`
2. Verifica se tem operador atribuído (OPERADOR != 0)
3. Verifica se o operador está no mesmo setor
4. ✅ Se tudo OK: Finaliza e cria chat para o operador
5. ❌ Se não: Continua para o próximo step

**Pré-requisitos**:
- `contact.customerId` deve estar preenchido
- Operador deve estar no mesmo setor

**Configuração**: Não requer configuração

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, description
) VALUES (
    1, 'CHECK_LOALTY', 2, 3, 'Verifica fidelização do cliente'
);
```

**Query Executada**:
```sql
SELECT * FROM campanhas_clientes cc
WHERE cc.CLIENTE = ?
ORDER BY CODIGO DESC LIMIT 1;
```

**Resultado**:
```typescript
{
    instance: "karsten",
    type: "RECEPTIVE",
    userId: 42,              // Operador da campanha
    sectorId: 1,
    contactId: 123
}
```

**Log Example**:
```
[Step #2] Iniciando execução: CheckLoaltyStep
Iniciando etapa de checagem de fidelização...
Buscando agendamento do cliente...
O usuário está no mesmo setor.
Chat criado com sucesso. { userId: 42, ... }
[Step #2] Finalizou com chat
```

---

### 3. CHECK_AVAILABLE_USERS

**Descrição**: Busca usuários online no setor e distribui para o que tem menos chats ativos.

**Tipo**: `CHECK_AVAILABLE_USERS`

**Quando Usar**: Para distribuição automática baseada em carga de trabalho.

**Comportamento**:
1. Busca sessões online no setor
2. Conta chats ativos de cada usuário
3. Ordena por menor número de chats
4. ✅ Se encontrar usuários: Finaliza e atribui ao usuário com menos chats
5. ❌ Se não encontrar: Continua para o próximo step (fallback)

**Configuração**: Não requer configuração

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, 
    fallback_step_id, description
) VALUES (
    1, 'CHECK_AVAILABLE_USERS', 3, NULL, 4, 
    'Distribui para usuário com menos chats'
);
```

**Resultado**:
```typescript
{
    instance: "karsten",
    type: "RECEPTIVE",
    userId: 15,              // Usuário com menos chats
    sectorId: 1,
    contactId: 123
}
```

**Log Example**:
```
[Step #3] Iniciando execução: CheckAvailableUsersStep
Verificando usuários disponíveis...
Encontradas 3 sessões online
Usuário 15 será atribuído ao chat. { userId: 15, chats: 2 }
[Step #3] Finalizou com chat
```

---

### 4. SEND_TO_ADMIN

**Descrição**: Envia o chat para o admin do setor como fallback final.

**Tipo**: `SEND_TO_ADMIN`

**Quando Usar**: Como último step do fluxo, garantindo que todo chat seja atendido.

**Comportamento**:
- Sempre finaliza e cria chat para admin (userId = -1)

**Configuração**: Não requer configuração

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, description
) VALUES (
    1, 'SEND_TO_ADMIN', 4, NULL, 'Fallback: envia para admin'
);
```

**Resultado**:
```typescript
{
    instance: "karsten",
    type: "RECEPTIVE",
    userId: -1,              // Admin
    sectorId: 1,
    contactId: 123
}
```

---

### 5. SEND_TO_SECTOR_USER

**Descrição**: Envia para um usuário do setor, com opção de preferir admin.

**Tipo**: `SEND_TO_SECTOR_USER`

**Quando Usar**: Quando quiser atribuir a qualquer usuário do setor.

**Comportamento**:
1. Busca usuários do setor
2. Se `preferAdmin = true` (padrão): Busca ADMIN primeiro
3. Se não encontrar admin ou `preferAdmin = false`: Pega primeiro usuário
4. Finaliza e cria chat

**Configuração**:
```json
{
    "preferAdmin": true  // Opcional, padrão: true
}
```

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, 
    config, description
) VALUES (
    1, 'SEND_TO_SECTOR_USER', 5, NULL,
    JSON_OBJECT('preferAdmin', false),
    'Envia para qualquer usuário do setor'
);
```

**Resultado**:
```typescript
{
    instance: "karsten",
    type: "RECEPTIVE",
    userId: 8,               // Primeiro usuário encontrado
    sectorId: 1,
    contactId: 123
}
```

---

## 🔧 Steps Genéricos (Configuráveis)

Estes steps são altamente configuráveis e podem ser usados para criar lógicas customizadas.

### 6. QUERY

**Descrição**: Executa uma query SQL e armazena o resultado no contexto.

**Tipo**: `QUERY`

**Quando Usar**: 
- Buscar dados de tabelas legadas
- Verificar condições complexas
- Enriquecer contexto com dados externos

**Configuração Obrigatória**:
- `query` (string): Query SQL a executar
- `storeAs` (string): Nome da variável no contexto

**Configuração Opcional**:
- `params` (array): Parâmetros da query (suporta interpolação)
- `single` (boolean): Se true, retorna apenas primeiro resultado
- `required` (boolean): Se true e sem resultados, usa fallback

**Interpolação de Variáveis**:
```json
{
    "params": ["${contact.customerId}", "${contact.phone}"]
}
```

**Exemplo SQL**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'QUERY', 1, 2,
    JSON_OBJECT(
        'query', 'SELECT * FROM clientes WHERE codigo = ?',
        'params', JSON_ARRAY('${contact.customerId}'),
        'storeAs', 'customer',
        'single', true,
        'required', true
    )
);
```

**Contexto Após Execução**:
```typescript
context.customer = {
    CODIGO: 123,
    NOME: "João Silva",
    TIPO: "VIP",
    SETOR: 1
}
```

**Com Fallback**:
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, 
    fallback_step_id, config
) VALUES (
    1, 'QUERY', 1, 2, 10,  -- Se falhar, vai para step 10
    JSON_OBJECT(
        'query', 'SELECT * FROM vendedores WHERE ativo = 1',
        'storeAs', 'vendedores',
        'required', true
    )
);
```

**Log Example**:
```
[Step #1] Iniciando execução: QueryStep
Executando query { query: 'SELECT * FROM clientes...', storeAs: 'customer' }
Query retornou 1 resultado(s)
Resultado armazenado em context.customer
[Step #1] Próximo step: #2
```

---

### 7. CONDITION

**Descrição**: Avalia uma condição e roteia o fluxo baseado no resultado (true/false).

**Tipo**: `CONDITION`

**Quando Usar**:
- Decisões binárias (sim/não)
- Validações de campos
- Verificações de regras de negócio

**Configuração Obrigatória**:
- `field` (string): Campo a verificar (dot notation)
- `operator` (string): Operador de comparação
- `value` (any): Valor para comparar
- `onTrue` (number): Step para ir se condição verdadeira
- `onFalse` (number): Step para ir se condição falsa

**Operadores Disponíveis**:

| Operador | Alias | Descrição | Exemplo |
|----------|-------|-----------|---------|
| `equals` | `==` | Igualdade | `field === value` |
| `notEquals` | `!=` | Diferença | `field !== value` |
| `contains` | - | Contém (string/array) | `field.includes(value)` |
| `in` | - | Está em array | `value.includes(field)` |
| `gt` | `>` | Maior que | `field > value` |
| `gte` | `>=` | Maior ou igual | `field >= value` |
| `lt` | `<` | Menor que | `field < value` |
| `lte` | `<=` | Menor ou igual | `field <= value` |
| `exists` | - | Campo existe | `field !== undefined` |
| `notExists` | - | Campo não existe | `field === undefined` |
| `regex` | - | Regex match | `new RegExp(value).test(field)` |
| `between` | - | Entre valores | `field >= min && field <= max` |

**Exemplos SQL**:

#### Verificar se é VIP
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'CONDITION', 1,
    JSON_OBJECT(
        'field', 'customer.TIPO',
        'operator', 'equals',
        'value', 'VIP',
        'onTrue', 2,   -- Vai para step VIP
        'onFalse', 3   -- Vai para step normal
    )
);
```

#### Verificar múltiplos valores (IN)
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'CONDITION', 1,
    JSON_OBJECT(
        'field', 'customer.TIPO',
        'operator', 'in',
        'value', JSON_ARRAY('VIP', 'PREMIUM', 'GOLD'),
        'onTrue', 2,
        'onFalse', 3
    )
);
```

#### Verificar regex (telefone)
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'CONDITION', 1,
    JSON_OBJECT(
        'field', 'contact.phone',
        'operator', 'regex',
        'value', '^\\+55',      -- Começa com +55
        'onTrue', 2,
        'onFalse', 3
    )
);
```

#### Verificar range (between)
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'CONDITION', 1,
    JSON_OBJECT(
        'field', 'customer.CODIGO',
        'operator', 'between',
        'value', JSON_ARRAY(1000, 9999),
        'onTrue', 2,
        'onFalse', 3
    )
);
```

**Log Example**:
```
[Step #1] Iniciando execução: ConditionStep
Verificando condição: customer.TIPO equals VIP { fieldValue: 'VIP' }
Resultado da condição: true → Step 2
[Step #1] Próximo step: #2
```

---

### 8. ROUTER

**Descrição**: Roteia o fluxo para diferentes steps baseado no valor de um campo (switch/case).

**Tipo**: `ROUTER`

**Quando Usar**:
- Múltiplas ramificações (mais de 2 opções)
- Switch/case baseado em valor
- Roteamento por categoria/tipo

**Configuração Obrigatória**:
- `field` (string): Campo para avaliar
- `routes` (object): Mapa `valor → stepNumber`

**Configuração Opcional**:
- `default` (number): Step padrão se valor não encontrado

**Exemplo SQL**:

#### Router simples
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'ROUTER', 1, 5,  -- default: step 5
    JSON_OBJECT(
        'field', 'customer.TIPO',
        'routes', JSON_OBJECT(
            'VIP', 2,
            'PREMIUM', 3,
            'REGULAR', 4
        ),
        'default', 5
    )
);
```

#### Router por setor
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'ROUTER', 1,
    JSON_OBJECT(
        'field', 'customer.SETOR',
        'routes', JSON_OBJECT(
            '1', 10,    -- Setor 1 → step 10
            '2', 20,    -- Setor 2 → step 20
            '3', 30     -- Setor 3 → step 30
        ),
        'default', 99
    )
);
```

#### Router por horário
```sql
-- Primeiro busca a hora
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'QUERY', 1, 2,
    JSON_OBJECT(
        'query', 'SELECT HOUR(NOW()) as hora',
        'storeAs', 'horario',
        'single', true
    )
);

-- Depois roteia
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, config
) VALUES (
    1, 'ROUTER', 2,
    JSON_OBJECT(
        'field', 'horario.hora',
        'routes', JSON_OBJECT(
            '8', 10,    -- Manhã
            '9', 10,
            '14', 20,   -- Tarde
            '15', 20,
            '18', 30    -- Noite
        ),
        'default', 40
    )
);
```

**Diferença entre CONDITION e ROUTER**:
- **CONDITION**: Binário (true/false), usa operadores de comparação
- **ROUTER**: Múltiplos caminhos, usa valores exatos

**Log Example**:
```
[Step #1] Iniciando execução: RouterStep
Roteando baseado em customer.TIPO { value: 'VIP' }
Rota selecionada: #2
[Step #1] Próximo step: #2
```

---

### 9. ASSIGN

**Descrição**: Atribui o chat a um usuário, carteira ou admin, com opções avançadas.

**Tipo**: `ASSIGN`

**Quando Usar**:
- Atribuição direta a usuário específico
- Atribuição a carteira
- Definir prioridade do chat
- Adicionar mensagem do sistema

**Configuração**:
- `userId` (number|string): ID do usuário ou `${variavel}`
- `walletId` (number|string): ID da carteira ou `${variavel}`
- `priority` (string): Prioridade (`LOW`, `MEDIUM`, `HIGH`)
- `systemMessage` (string): Mensagem do sistema (suporta interpolação)
- `type` (string): Tipo do chat (`RECEPTIVE` ou `ACTIVE`)

**Exemplos SQL**:

#### Assign direto para usuário
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'ASSIGN', 5, NULL,
    JSON_OBJECT(
        'userId', 10,
        'priority', 'HIGH',
        'systemMessage', 'Cliente VIP prioritário'
    )
);
```

#### Assign para carteira
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'ASSIGN', 5, NULL,
    JSON_OBJECT(
        'walletId', 3,
        'priority', 'MEDIUM'
    )
);
```

#### Assign com interpolação de variáveis
```sql
-- Primeiro busca o vendedor
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'QUERY', 1, 2,
    JSON_OBJECT(
        'query', 'SELECT vendedor_id FROM clientes WHERE codigo = ?',
        'params', JSON_ARRAY('${contact.customerId}'),
        'storeAs', 'vendedor',
        'single', true
    )
);

-- Depois atribui ao vendedor
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'ASSIGN', 2, NULL,
    JSON_OBJECT(
        'userId', '${vendedor.vendedor_id}',
        'systemMessage', 'Cliente: ${customer.NOME} (Código: ${customer.CODIGO})'
    )
);
```

#### Assign para admin com mensagem
```sql
INSERT INTO message_flows_steps (
    message_flow_id, type, step_number, next_step_id, config
) VALUES (
    1, 'ASSIGN', 10, NULL,
    JSON_OBJECT(
        'userId', -1,
        'priority', 'HIGH',
        'systemMessage', 'Cliente novo sem vendedor atribuído: ${contact.phone}'
    )
);
```

**Prioridades**:
- `LOW`: Prioridade baixa (fila normal)
- `MEDIUM`: Prioridade média (padrão)
- `HIGH`: Prioridade alta (vai para o topo)

**Interpolação de Mensagens**:
```javascript
// Template
"Cliente: ${customer.NOME} - Tipo: ${customer.TIPO}"

// Resultado
"Cliente: João Silva - Tipo: VIP"
```

**Log Example**:
```
[Step #5] Iniciando execução: AssignStep
System message interpolated: "Cliente: ${customer.NOME}" → "Cliente: João Silva"
Chat atribuído { userId: 10, priority: 'HIGH', systemMessage: '...' }
[Step #5] Finalizou com chat
```

---

## 🎓 Guia de Uso dos Steps

### Fluxo Linear Básico
```
CHECK_ONLY_ADMIN → CHECK_LOALTY → CHECK_AVAILABLE_USERS → SEND_TO_ADMIN
```

### Fluxo com Query e Condição
```
QUERY (busca dados) → CONDITION (verifica) → ASSIGN (atribui)
```

### Fluxo com Roteamento
```
QUERY (busca tipo) → ROUTER (roteia) → [múltiplos ASSIGN]
```

### Fluxo Complexo
```
QUERY → CONDITION → ROUTER → QUERY → CONDITION → ASSIGN
```

## 📊 Contexto Disponível nos Steps

### Campos do Contexto

```typescript
interface StepContext {
    // Sempre disponível
    contact: WppContact;        // Dados do contato
    logger: ProcessingLogger;   // Logger
    
    // Adicionados pelos steps
    instance?: string;          // Nome da instância
    sectorId?: number;          // ID do setor
    customer?: Customer;        // Cliente (se buscado)
    legacyCampaignType?: string;
    legacySchedule?: CustomerSchedule;
    
    // Variáveis customizadas (adicionadas por QUERY)
    [key: string]: any;
}
```

### Campos do Contact

```typescript
interface WppContact {
    id: number;
    phone: string;
    name?: string;
    customerId?: number;
    isOnlyAdmin: boolean;
    profilePicUrl?: string;
    // ... outros campos
}
```

### Acessando Dados no Contexto

```json
{
    "field": "contact.customerId",      // ID do cliente
    "field": "contact.phone",           // Telefone
    "field": "contact.name",            // Nome
    "field": "customer.TIPO",           // Tipo do cliente (se buscado)
    "field": "vendedor.CODIGO",         // Código do vendedor (se buscado)
    "field": "horario.hora"             // Hora (se buscado)
}
```

## 🔍 Troubleshooting

### Step não executa
- Verifique se `enabled = true`
- Verifique se `next_step_id` está correto
- Veja os logs para erros

### Condição sempre false
- Verifique o tipo do valor (`"1"` vs `1`)
- Use `exists` antes de comparar
- Verifique o campo no contexto

### Query sem resultados
- Use `required = false` se for opcional
- Adicione `fallback_step_id`
- Verifique a query no banco

### Router não encontra rota
- Adicione `default`
- Verifique valores exatos (case-sensitive)
- Use String para todos os valores

## 📚 Referências

- [Manual de Criação de Fluxos](./MANUAL_CRIACAO_FLUXOS.md)
- [Exemplos Práticos](./EXEMPLOS_PRATICOS_FLUXOS.md)
- [Nomenclatura de Steps](../refactor/NOMENCLATURA_STEPS.md)
