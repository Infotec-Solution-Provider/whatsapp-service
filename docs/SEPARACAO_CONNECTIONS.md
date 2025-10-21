# Separação de Conexões do Config

**Data:** 17 de outubro de 2025  
**Branch:** refactor/flow

## 📋 Resumo

Separamos as conexões condicionais/dinâmicas (onTrue, onFalse, routes) do campo `config` para um novo campo `connections` na tabela `wpp_message_flow_steps`. Isso melhora a arquitetura e a UX do editor de fluxos.

## 🎯 Motivação

**Problema Original:**
- Conexões condicionais (CONDITION: onTrue/onFalse) estavam dentro do JSON `config`
- Rotas dinâmicas (ROUTER: routes) também estavam no `config`
- Usuários precisavam editar JSON manualmente para definir conexões
- Difícil visualizar e manter conexões no diagrama

**Solução:**
- Novo campo `connections` no schema para armazenar conexões separadamente
- Interface visual (ConnectionsEditor) para gerenciar conexões sem editar JSON
- `config` agora contém apenas configurações específicas do step
- `connections` contém apenas a lógica de roteamento

## 🗄️ Mudanças no Banco de Dados

### Schema Prisma

```prisma
model WppMessageFlowStep {
  // ... outros campos
  config         Json?     @map("config")       // Configuração específica (sem conexões)
  connections    Json?     @map("connections")  // Conexões condicionais/dinâmicas
  // ... outros campos
}
```

### Migration

```sql
-- Arquivo: prisma/migrations/20251017222525_add_connections_field/migration.sql
ALTER TABLE `wpp_message_flow_steps` ADD COLUMN `connections` JSON NULL;
```

### Migração de Dados

Script criado em `prisma/migrations/migrate_connections.sql`:

- Move `onTrue` e `onFalse` de `config` para `connections` (CONDITION)
- Move `routes` e `default` de `config` para `connections` (ROUTER)
- Remove esses campos do `config` após migração

**⚠️ Executar manualmente quando necessário:**
```bash
mysql -u user -p database < prisma/migrations/migrate_connections.sql
```

## 📊 Estrutura de Dados

### CONDITION

**Antes (config):**
```json
{
  "field": "contact.isOnlyAdmin",
  "operator": "equals",
  "value": true,
  "onTrue": 5,
  "onFalse": 6
}
```

**Depois:**

`config`:
```json
{
  "field": "contact.isOnlyAdmin",
  "operator": "equals",
  "value": true
}
```

`connections`:
```json
{
  "onTrue": 5,
  "onFalse": 6
}
```

### ROUTER

**Antes (config):**
```json
{
  "field": "message.body",
  "routes": {
    "1": 10,
    "2": 20,
    "3": 30
  },
  "default": 99
}
```

**Depois:**

`config`:
```json
{
  "field": "message.body"
}
```

`connections`:
```json
{
  "routes": {
    "1": 10,
    "2": 20,
    "3": 30
  },
  "defaultRoute": 99
}
```

## 🎨 Frontend

### Novos Tipos TypeScript

```typescript
export interface StepConnections {
  // CONDITION
  onTrue?: number;
  onFalse?: number;
  
  // ROUTER
  routes?: Record<string, number>;
  defaultRoute?: number;
}

export interface FlowStep {
  // ... outros campos
  config: Record<string, any>;
  connections: StepConnections | null;
  // ... outros campos
}
```

### Novo Componente: ConnectionsEditor

**Localização:** `src/frontend/components/ConnectionsEditor.tsx`

**Funcionalidade:**
- **CONDITION:** Selects visuais para onTrue e onFalse
- **ROUTER:** Interface para adicionar/editar/remover rotas
  - Campo de texto para chave/valor da rota
  - Select para step de destino
  - Botão para adicionar novas rotas
  - Select para rota padrão
- Validação visual (alerts quando faltam conexões)
- Lista apenas steps disponíveis (exclui auto-referência)

### StepEditor Atualizado

**Mudanças:**
1. Importa `ConnectionsEditor` e `StepConnections`
2. Adiciona `connections` ao state do formulário
3. Renderiza `ConnectionsEditor` condicionalmente para CONDITION e ROUTER
4. Envia `connections` separadamente na criação/atualização
5. Atualiza exemplos de configuração (remove onTrue/onFalse/routes)

### FlowDiagram Atualizado

**Mudanças:**
- Lê conexões de `step.connections` em vez de `step.config`
- Cores diferentes para cada tipo de conexão:
  - **onTrue:** Verde (#10b981) - "✓ True"
  - **onFalse:** Vermelho (#ef4444) - "✗ False"
  - **routes:** Roxo (#8b5cf6) - Nome da chave
  - **defaultRoute:** Cinza (#64748b, tracejado) - "Default"

## ✅ Benefícios

1. **Separação de Responsabilidades:**
   - `config` = comportamento do step
   - `connections` = lógica de roteamento

2. **UX Melhorada:**
   - Interface visual para conexões
   - Sem necessidade de editar JSON manualmente
   - Validação em tempo real

3. **Manutenibilidade:**
   - Mais fácil entender estrutura de dados
   - Queries específicas para conexões possíveis
   - Diagrama mais robusto

4. **Escalabilidade:**
   - Fácil adicionar novos tipos de conexões
   - Base para features futuras (validação de fluxo, análise de caminhos)

## 🔄 Retrocompatibilidade

**Dados Antigos:**
- Steps existentes com conexões no `config` continuam funcionando
- Script de migração move dados quando executado
- Frontend lê ambos (connections primeiro, fallback para config)

**Novos Steps:**
- Sempre usam `connections` para CONDITION e ROUTER
- `config` não contém mais onTrue/onFalse/routes

## 🧪 Testes

### Checklist Manual

- [ ] Criar step CONDITION com onTrue/onFalse via ConnectionsEditor
- [ ] Criar step ROUTER com múltiplas rotas via ConnectionsEditor
- [ ] Visualizar conexões no FlowDiagram (cores corretas)
- [ ] Editar conexões existentes
- [ ] Remover conexões
- [ ] Validação de campos obrigatórios
- [ ] Steps antigos ainda funcionam (retrocompatibilidade)

## 📚 Arquivos Modificados

### Backend
- `prisma/schema.prisma` - Adicionado campo `connections`
- `prisma/migrations/20251017222525_add_connections_field/` - Migration
- `prisma/migrations/migrate_connections.sql` - Script de migração de dados

### Frontend
- `src/frontend/types/flow.types.ts` - Tipos `StepConnections`, atualização de `FlowStep`, DTOs
- `src/frontend/components/ConnectionsEditor.tsx` - **NOVO** componente
- `src/frontend/components/StepEditor.tsx` - Integração do ConnectionsEditor
- `src/frontend/components/FlowDiagram.tsx` - Leitura de `connections` em vez de `config`

### Documentação
- `docs/SEPARACAO_CONNECTIONS.md` - **ESTE ARQUIVO**

## 🚀 Próximos Passos

1. **Executar migração de dados** em produção
2. **Testes extensivos** com fluxos complexos
3. **Feedback de usuários** sobre nova interface
4. **Considerar features futuras:**
   - Validação de fluxo (detectar caminhos quebrados)
   - Análise de cobertura (todos os casos cobertos?)
   - Sugestões de conexões (IA?)
   - Exportação/importação visual de fluxos

## 📝 Notas Técnicas

- `connections` usa mesmo tipo `Json` do Prisma (flexibilidade)
- ConnectionsEditor é reusável e extensível
- FlowDiagram suporta múltiplos tipos de conexões simultaneamente
- Validação no frontend, mas backend deve validar também (futuro)
