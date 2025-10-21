# 🔧 Correções no MessageFlowFactory

## ❌ Problema Identificado

O método `createMessageFlow` estava **ignorando** os campos `next_step_id` e `fallback_step_id` do banco de dados e simplesmente incrementando uma variável `currentStepNumber`.

### Código Antigo (Errado)
```typescript
let currentStepNumber = 1;

for (const step of flow.WppMessageFlowStep) {
    // ❌ ERRADO: Ignorava next_step_id do banco
    const nextStepNumber = step.type === "SEND_TO_ADMIN" ? undefined : currentStepNumber + 1;
    const stepInstance = this.createStep(
        step.type as string,
        instance,
        sectorId,
        currentStepNumber,  // Usava variável incrementada
        nextStepNumber,     // Calculado, não do banco!
        MessageFlowFactory.getValidatedStepConfig(step.config)
    );
    messageFlow.addStep(stepInstance);
    currentStepNumber++; // ❌ Incrementava sempre
}
```

### Problemas Causados

1. **Impossível criar fluxos não-lineares**: Não podia fazer `1 → 3 → 2 → 5`
2. **Fallback não funcionava**: `fallback_step_id` era ignorado
3. **Configuração do banco inútil**: Os campos `next_step_id` e `fallback_step_id` não eram usados

## ✅ Solução Implementada

### Código Novo (Correto)
```typescript
// Ordena os steps por stepNumber para garantir a ordem correta
const sortedSteps = [...flow.WppMessageFlowStep].sort((a, b) => a.stepNumber - b.stepNumber);

for (const step of sortedSteps) {
    // ✅ CORRETO: Monta config com valores do banco
    const stepConfig: any = {
        stepNumber: step.stepNumber,
        instance,
        sectorId,
        config: MessageFlowFactory.getValidatedStepConfig(step.config)
    };

    // ✅ Usa nextStepId do banco
    if (step.nextStepId !== null && step.nextStepId !== undefined) {
        stepConfig.nextStepNumber = step.nextStepId;
    }

    // ✅ Usa fallbackStepId do banco
    if (step.fallbackStepId !== null && step.fallbackStepId !== undefined) {
        stepConfig.fallbackStepNumber = step.fallbackStepId;
    }

    Logger.debug(`[MessageFlowFactory] Creating step from database`, {
        type: step.type,
        stepNumber: step.stepNumber,
        nextStepNumber: stepConfig.nextStepNumber,
        fallbackStepNumber: stepConfig.fallbackStepNumber,
        hasConfig: !!step.config
    });

    const stepInstance = this.createStep(
        step.type as string,
        instance,
        sectorId,
        step.stepNumber,              // Do banco
        stepConfig.nextStepNumber,    // Do banco
        stepConfig.config,
        stepConfig.fallbackStepNumber // Do banco (novo)
    );
    
    messageFlow.addStep(stepInstance);
}
```

### Mudanças no createStep

Adicionado suporte ao `fallbackStepNumber`:

```typescript
private static createStep(
    type: string,
    instance: string,
    sectorId: number,
    stepNumber: number,
    nextStepNumber?: number,
    config?: Record<string, any>,
    fallbackStepNumber?: number  // ✅ Novo parâmetro
): BaseStep {
    // ...
    
    if (fallbackStepNumber !== undefined) {
        stepConfig.fallbackStepNumber = fallbackStepNumber;
    }
    
    // ...
}
```

## 🎯 Benefícios

### 1. Fluxos Não-Lineares Funcionam
```sql
-- Agora isso funciona!
INSERT INTO message_flows_steps (..., step_number, next_step_id) VALUES
(1, 1, 3),  -- Step 1 pula para 3
(1, 2, 5),  -- Step 2 pula para 5
(1, 3, 2),  -- Step 3 volta para 2
(1, 4, NULL),
(1, 5, 4);  -- Step 5 vai para 4
```

### 2. Fallback Funciona
```sql
-- Step com fallback
INSERT INTO message_flows_steps (..., step_number, next_step_id, fallback_step_id) VALUES
(1, 3, 4, 10);  -- Se step 3 falhar, vai para step 10
```

### 3. Configuração do Banco é Respeitada
Os campos `next_step_id` e `fallback_step_id` agora controlam de verdade o fluxo!

### 4. Logs Detalhados
```
[MessageFlowFactory] Creating step from database {
  type: 'CHECK_AVAILABLE_USERS',
  stepNumber: 3,
  nextStepNumber: 4,
  fallbackStepNumber: 10,
  hasConfig: false
}
```

## 📝 Impacto

### Breaking Changes
❌ **Nenhum!** Fluxos existentes continuam funcionando.

### Novos Recursos
✅ Agora é possível:
- Criar fluxos não-lineares
- Usar fallback_step_id
- Ter controle total sobre a ordem de execução
- Criar loops controlados (com cuidado!)

## 🧪 Testando

### Fluxo Linear (ainda funciona)
```sql
INSERT INTO message_flows_steps (...) VALUES
(1, 'CHECK_ONLY_ADMIN', 1, 2, NULL),
(1, 'CHECK_LOALTY', 2, 3, NULL),
(1, 'CHECK_AVAILABLE_USERS', 3, 4, NULL),
(1, 'SEND_TO_ADMIN', 4, NULL, NULL);
```

### Fluxo Não-Linear (agora funciona!)
```sql
INSERT INTO message_flows_steps (...) VALUES
(1, 'QUERY', 1, 2, NULL),
(1, 'ROUTER', 2, 5, NULL),  -- Default vai para 5
(1, 'ASSIGN', 3, NULL, NULL), -- VIP
(1, 'ASSIGN', 4, NULL, NULL), -- Premium
(1, 'CHECK_AVAILABLE_USERS', 5, 6, 6); -- Com fallback para 6
(1, 'SEND_TO_ADMIN', 6, NULL, NULL);
```

## ⚠️ Cuidados

### Evite Loops Infinitos
```sql
-- ❌ PERIGO: Loop infinito!
INSERT INTO message_flows_steps (...) VALUES
(1, 'CONDITION', 1, 2, NULL),
(1, 'CONDITION', 2, 1, NULL);  -- Volta para 1!
```

### Step Final Deve Ter next_step_id = NULL
```sql
-- ✅ Correto
INSERT INTO message_flows_steps (..., next_step_id) VALUES
(..., NULL);  -- Finaliza aqui
```

### Valide os IDs
```sql
-- ❌ ERRO: Step 10 não existe!
INSERT INTO message_flows_steps (..., next_step_id) VALUES
(..., 10);  -- Se step 10 não existir, vai dar erro em runtime
```

## 📚 Referências

- [Manual de Criação de Fluxos](./MANUAL_CRIACAO_FLUXOS.md)
- [Documentação dos Steps](./STEPS_DOCUMENTATION.md)
- [Nomenclatura de Steps](../refactor/NOMENCLATURA_STEPS.md)
