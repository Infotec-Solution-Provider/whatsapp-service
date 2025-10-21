# Separação de Conexões do Config

## Motivação

Anteriormente, as conexões condicionais e de roteamento (`onTrue`, `onFalse`, `routes`) estavam misturadas no campo `config` JSON, o que causava:

1. **Confusão arquitetural**: Config deveria ter configuração do step, não conexões
2. **UX ruim**: Usuário tinha que editar JSON manualmente para conexões
3. **Difícil validação**: Não era possível validar facilmente se conexões eram válidas
4. **Diagrama complexo**: ReactFlow tinha que buscar conexões em lugares diferentes

## Solução

Criamos um campo separado `connections` no banco de dados e um editor visual no frontend.

### Schema

```prisma
model WppMessageFlowStep {
  // ...
  config         Json?  // Configuração específica do step (SEM conexões)
  connections    Json?  // Conexões condicionais/dinâmicas (onTrue, onFalse, routes)
  // ...
}
```

### Estrutura de Connections

```typescript
interface StepConnections {
  // CONDITION
  onTrue?: number;    // ID do step para condição verdadeira
  onFalse?: number;   // ID do step para condição falsa
  
  // ROUTER
  routes?: Record<string, number>;  // Mapa de valor -> ID do step
  defaultRoute?: number;             // Rota padrão
}
```

### Exemplos

#### CONDITION (antes)
```json
{
  "config": {
    "field": "contact.isOnlyAdmin",
    "operator": "equals",
    "value": true,
    "onTrue": 5,    // ❌ Conexão no config
    "onFalse": 6    // ❌ Conexão no config
  }
}
```

#### CONDITION (depois)
```json
{
  "config": {
    "field": "contact.isOnlyAdmin",
    "operator": "equals",
    "value": true
  },
  "connections": {
    "onTrue": 5,    // ✅ Conexão separada
    "onFalse": 6    // ✅ Conexão separada
  }
}
```

#### ROUTER (antes)
```json
{
  "config": {
    "field": "message.body",
    "routes": {         // ❌ Conexões no config
      "1": 10,
      "2": 20
    },
    "default": 99       // ❌ Conexão no config
  }
}
```

#### ROUTER (depois)
```json
{
  "config": {
    "field": "message.body"
  },
  "connections": {
    "routes": {         // ✅ Conexões separadas
      "1": 10,
      "2": 20
    },
    "defaultRoute": 99  // ✅ Conexão separada
  }
}
```

## Frontend

### ConnectionsEditor Component

Novo componente visual que substitui edição manual de JSON:

- **CONDITION**: 2 selects (onTrue, onFalse)
- **ROUTER**: Lista dinâmica de rotas (chave → step) + rota padrão

### StepEditor Integration

O `StepEditor` agora mostra:

1. **Campos básicos**: stepNumber, type, description, enabled
2. **Conexões principais**: nextStepId, fallbackStepId
3. **Conexões condicionais** (só para CONDITION/ROUTER): `ConnectionsEditor` visual
4. **Configuração**: JSON editor (sem conexões)

## FlowDiagram

O diagrama agora busca conexões de `step.connections`:

```typescript
// CONDITION
if (step.connections?.onTrue) {
  // Cria edge verde "True"
}
if (step.connections?.onFalse) {
  // Cria edge vermelho "False"
}

// ROUTER
Object.entries(step.connections?.routes || {}).forEach(([key, stepId]) => {
  // Cria edge roxo com label da chave
});
```

## Migração de Dados

Execute o script de migração para mover dados existentes:

```bash
mysql -u root -p whatsapp < prisma/migrations/migrate_connections.sql
```

Ou use o Prisma Studio para editar manualmente steps com conexões.

## Benefícios

✅ **Separação clara**: Config para lógica, connections para fluxo
✅ **UX melhorada**: Editor visual em vez de JSON manual
✅ **Validação**: Fácil validar se conexões apontam para steps válidos
✅ **Diagrama robusto**: ReactFlow busca de um único lugar
✅ **Manutenção**: Mais fácil adicionar novos tipos de conexão
✅ **Escalabilidade**: Preparado para futuras melhorias (validação, autocomplete)

## Próximos Passos (Opcional)

1. **Tabela de conexões**: Para queries complexas sobre o fluxo
2. **Validação backend**: Garantir que conexões apontam para steps válidos
3. **Autocomplete**: Filtrar steps por tipo compatível
4. **Visualização**: Highlight de conexões no diagrama ao hover
