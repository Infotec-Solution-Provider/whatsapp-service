# Refatoração da Nomenclatura de Steps

## 📋 Resumo das Mudanças

Refatoração completa da nomenclatura para eliminar a confusão entre `stepId`, `step_id`, `stepNumber` e `step_number`.

## 🔄 Antes vs Depois

### Conceitos Claros Agora

| Conceito | Nome Antigo | Nome Novo | Descrição |
|----------|------------|-----------|-----------|
| **Posição no Fluxo** | `id`, `stepId` | `stepNumber` | Posição sequencial no fluxo (1, 2, 3, 4...) |
| **Próximo Step** | `nextStepId` | `nextStepNumber` | Número do próximo step na sequência |
| **Step Alternativo** | `fallbackStepId` | `fallbackStepNumber` | Step para usar em caso de erro |
| **ID do Banco** | `id` | `id` | ID autoincrement do registro (sem mudança) |

### Estrutura do Map

```typescript
// Antes (confuso)
private steps: Map<number, BaseStep> = new Map();
// Não estava claro: esse number era id ou stepNumber?

// Depois (claro)
private steps: Map<number, BaseStep> = new Map(); // Map<stepNumber, BaseStep>
// Agora é explícito: a chave é o stepNumber (posição no fluxo)
```

## 📁 Arquivos Modificados

### 1. `src/message-flow/base/base.step.ts`

#### StepConfig Interface
```typescript
// Antes
export interface StepConfig {
	id: number;
	nextStepId?: number;
	fallbackStepId?: number;
	// ...
}

// Depois
export interface StepConfig {
	stepNumber: number; // Posição sequencial no fluxo (1, 2, 3...)
	nextStepNumber?: number; // Próxima posição no fluxo
	fallbackStepNumber?: number; // Posição alternativa em caso de erro
	// ...
}
```

#### StepResult Interface
```typescript
// Antes
export interface StepResult {
	isFinal: boolean;
	stepId?: number; // CONFUSO!
	chatData?: ChatPayload;
	context: StepContext;
}

// Depois
export interface StepResult {
	isFinal: boolean;
	nextStepNumber?: number; // CLARO: próxima posição no fluxo
	chatData?: ChatPayload;
	context: StepContext;
}
```

#### BaseStep Class
```typescript
// Antes
export abstract class BaseStep {
	public readonly id: number;
	protected readonly nextStepId: number | undefined;
	protected readonly fallbackStepId: number | undefined;
	// ...
}

// Depois
export abstract class BaseStep {
	public readonly stepNumber: number; // Posição sequencial no fluxo
	protected readonly nextStepNumber: number | undefined;
	protected readonly fallbackStepNumber: number | undefined;
	// ...
}
```

### 2. `src/message-flow/message-flow.ts`

#### Variáveis e Métodos
```typescript
// Antes (nomes inconsistentes)
let currStepId = 1;
getStep(stepId: number)
getNextStepId(result: StepResult, currStepId: number)

// Depois (nomes consistentes)
let currentStepNumber = 1; // Sempre começa na etapa #1
getStep(stepNumber: number)
getNextStepNumber(result: StepResult, currentStepNumber: number)
```

#### Logs Melhorados
```typescript
// Antes
logger.debug(`Iteração ${stepCount} - Tentando executar etapa ID: ${currStepId}`);

// Depois
logger.debug(`Iteração ${iterationCount} - Tentando executar etapa #${currentStepNumber}`);
```

### 3. `src/message-flow/message-flow.factory.ts`

#### Parâmetros da createStep
```typescript
// Antes
private static createStep(
	type: string,
	instance: string,
	sectorId: number,
	stepId: number,
	nextStepId?: number,
	config?: Record<string, any>
): BaseStep

// Depois
private static createStep(
	type: string,
	instance: string,
	sectorId: number,
	stepNumber: number,
	nextStepNumber?: number,
	config?: Record<string, any>
): BaseStep
```

#### Default Flow
```typescript
// Antes
const steps = [
	{ type: "CHECK_ONLY_ADMIN", stepId: 1, nextStepId: 2 },
	{ type: "CHECK_LOALTY", stepId: 2, nextStepId: 3 },
	// ...
];

// Depois
const steps = [
	{ type: "CHECK_ONLY_ADMIN", stepNumber: 1, nextStepNumber: 2 },
	{ type: "CHECK_LOALTY", stepNumber: 2, nextStepNumber: 3 },
	// ...
];
```

### 4. `src/message-flow/base/query.step.ts`

```typescript
// Antes
if (this.fallbackStepId) {
	return this.continue(context, this.fallbackStepId);
}

// Depois
if (this.fallbackStepNumber) {
	return this.continue(context, this.fallbackStepNumber);
}
```

### 5. `src/message-flow/base/router.step.ts`

```typescript
// Antes
interface RouterConfig {
	routes: Record<string, number>; // Mapa valor → stepId
	default?: number; // Step padrão
}
let nextStepId = config.routes[String(value)];

// Depois
interface RouterConfig {
	routes: Record<string, number>; // Mapa valor → stepNumber
	default?: number; // Step padrão
}
let nextStepNumber = config.routes[String(value)];
```

## 🎯 Benefícios da Refatoração

### 1. **Clareza de Nomenclatura**
- `stepNumber` deixa claro que é uma posição/ordem no fluxo
- `nextStepNumber` é autoexplicativo: próximo número na sequência
- Elimina confusão com `id` (que é o ID do banco de dados)

### 2. **Consistência no Código**
- Todos os arquivos usam a mesma nomenclatura
- Variáveis têm nomes completos (não abreviados): `currentStepNumber` vs `currStepId`
- Logs padronizados com `#` indicando número: `Etapa #1`, `Etapa #2`

### 3. **Logs Mais Informativos**
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
[Step #1] Próximo step: #2
[MessageFlow] Próxima etapa a ser executada: #2
```

### 4. **Alinhamento com o Schema do Prisma**
O schema já usa `stepNumber`:
```prisma
model WppMessageFlowStep {
  stepNumber     Int    @map("step_number")
  nextStepId     Int?   @map("next_step_id")
  fallbackStepId Int?   @map("fallback_step_id")
  // ...
}
```

Agora nosso código TypeScript está alinhado:
- `stepNumber` no código ↔ `step_number` no banco
- `nextStepNumber` no código ↔ `next_step_id` no banco
- `fallbackStepNumber` no código ↔ `fallback_step_id` no banco

## 🔍 Padrão de Uso

### Criar um Step
```typescript
const step = new CheckOnlyAdminStep({
	stepNumber: 1,        // Posição no fluxo
	nextStepNumber: 2,    // Próximo step
	instance: "karsten",
	sectorId: 1,
	config: {}
});
```

### Continuar para Próximo Step
```typescript
// Usar o nextStepNumber padrão
return this.continue(context);

// Ou especificar um número diferente
return this.continue(context, 5); // Pula para step #5
```

### Finalizar o Fluxo
```typescript
return this.finalize({
	instance: this.instance,
	type: WppChatType.ADMIN,
	sectorId: this.sectorId,
	contactId: context.contact.id
});
```

## ✅ Checklist de Migração

- [x] Atualizar `StepConfig` interface
- [x] Atualizar `StepResult` interface  
- [x] Atualizar `BaseStep` class
- [x] Atualizar `MessageFlow` class
- [x] Atualizar `MessageFlowFactory` class
- [x] Atualizar `QueryStep` class
- [x] Atualizar `RouterStep` class
- [x] Adicionar logs detalhados com `#` prefix
- [x] Testar compilação (sem erros TypeScript)
- [ ] Testar em runtime
- [ ] Atualizar documentação relacionada

## 📝 Notas Importantes

1. **O Map continua usando `number` como chave**, mas agora está documentado que é `stepNumber`
2. **Sempre começamos no step #1** (não é um ID do banco, é uma posição)
3. **Os logs usam `#` para indicar número**: `Etapa #1`, `#2`, etc.
4. **O schema do banco pode manter os nomes atuais** (`next_step_id`, `fallback_step_id`) pois são compatíveis

## 🚀 Próximos Passos

1. Testar o fluxo completo em desenvolvimento
2. Verificar se todos os logs estão corretos
3. Considerar renomear campos no Prisma schema para total consistência (opcional)
4. Atualizar documentação de flows existentes
