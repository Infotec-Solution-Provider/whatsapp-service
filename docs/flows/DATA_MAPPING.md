# Mapeamento de Dados: Backend → Frontend

## Problema Identificado

O **Prisma** retorna os steps com o nome da relação definida no schema (`WppMessageFlowStep`), mas o **frontend** espera uma propriedade chamada `steps`.

## Estrutura do Banco de Dados (Prisma Schema)

```prisma
model WppMessageFlow {
  id          Int      @id @default(autoincrement())
  instance    String
  sectorId    Int
  description String?
  
  WppMessageFlowStep WppMessageFlowStep[]  // ← Nome da relação
  
  @@map("message_flows")
}

model WppMessageFlowStep {
  id             Int                    @id
  type           WppMessageFlowStepType
  messageFlowId  Int
  stepNumber     Int
  config         Json?
  nextStepId     Int?
  fallbackStepId Int?
  enabled        Boolean
  description    String?
  
  WppMessageFlow WppMessageFlow @relation(...)
  
  @@map("message_flows_steps")
}
```

## Dados Retornados pelo Backend

```json
{
  "id": 1,
  "instance": "vollo",
  "sectorId": 1,
  "description": "Flow de vendas",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "updatedAt": "2025-01-01T00:00:00.000Z",
  "WppMessageFlowStep": [  // ← Prisma usa o nome da relação
    {
      "id": 1,
      "type": "QUERY",
      "messageFlowId": 1,
      "stepNumber": 1,
      "config": {},
      "nextStepId": 2,
      "fallbackStepId": null,
      "enabled": true,
      "description": "Pergunta inicial"
    }
  ]
}
```

## Dados Esperados pelo Frontend

```typescript
interface Flow {
  id: number;
  instance: string;
  sectorId: number | null;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  steps?: FlowStep[];  // ← Frontend espera "steps"
}

interface FlowStep {
  id: number;
  flowId: number;        // ← Backend retorna como "messageFlowId"
  stepNumber: number;
  stepType: WppMessageFlowStepType;  // ← Backend retorna como "type"
  nextStepId: number | null;
  fallbackStepId: number | null;
  config: Record<string, any>;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

## Solução Implementada

No componente **FlowEditor**, fazemos o mapeamento dos dados:

```typescript
// FlowEditor.tsx - linha 30+
if (initialFlow && (initialFlow as any).WppMessageFlowStep) {
  const mappedSteps = (initialFlow as any).WppMessageFlowStep.map((step: any) => ({
    id: step.id,
    flowId: step.messageFlowId,           // messageFlowId → flowId
    stepNumber: step.stepNumber,
    stepType: step.type,                  // type → stepType
    nextStepId: step.nextStepId,
    fallbackStepId: step.fallbackStepId,
    config: step.config || {},
    description: step.description,
    enabled: step.enabled,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt
  }));
  setSteps(mappedSteps);
}
```

## Mapeamento de Campos

| Backend (Prisma)        | Frontend (TypeScript)  | Observação                              |
|-------------------------|------------------------|-----------------------------------------|
| `WppMessageFlowStep[]`  | `steps?: FlowStep[]`   | Nome da propriedade diferente          |
| `messageFlowId`         | `flowId`               | Campo renomeado                        |
| `type`                  | `stepType`             | Campo renomeado                        |
| `config`                | `config`               | Mesmo nome, mas garante objeto vazio   |

## Como Funciona

1. **Backend** busca o flow com Prisma:
   ```typescript
   const flow = await prisma.wppMessageFlow.findUnique({
     where: { id: flowId },
     include: {
       WppMessageFlowStep: {  // ← Inclui a relação
         orderBy: { stepNumber: "asc" }
       }
     }
   });
   ```

2. **Frontend** recebe e mapeia:
   ```typescript
   // Detecta se vieram steps no objeto
   if (flow.WppMessageFlowStep) {
     // Mapeia para o formato esperado
     const steps = flow.WppMessageFlowStep.map(mapStep);
   } else {
     // Senão, busca separadamente via API
     const steps = await api.listSteps(flowId);
   }
   ```

3. **Resultado**: Steps carregados corretamente com nomes padronizados

## Alternativas Consideradas

### Opção 1: Mudar o nome da relação no Prisma ❌
```prisma
model WppMessageFlow {
  steps WppMessageFlowStep[]  // Mudaria para "steps"
}
```
**Problema**: Quebra todo o código existente que usa `WppMessageFlowStep`

### Opção 2: Criar DTO no backend ❌
```typescript
class FlowDTO {
  ...
  steps: StepDTO[];  // Backend faz o mapeamento
}
```
**Problema**: Aumenta complexidade e precisa mudar todo o service/controller

### Opção 3: Mapear no frontend ✅ (Implementado)
```typescript
const steps = flow.WppMessageFlowStep.map(mapStep);
```
**Vantagem**: Solução simples, não quebra código existente, frontend tem controle total

## Testando

1. Acesse: `http://localhost:8005/flows`
2. Selecione uma instância (ex: "vollo")
3. Clique em um flow
4. Os steps devem aparecer corretamente na visualização

## Debug

Se os steps não aparecerem:

1. **Abra o Console do navegador** (F12)
2. **Veja a aba Network** → Busque por `/api/message-flows/`
3. **Verifique a resposta**: deve conter `WppMessageFlowStep[]`
4. **Console.log no FlowEditor**: 
   ```typescript
   console.log('Flow recebido:', initialFlow);
   console.log('Steps mapeados:', mappedSteps);
   ```

## Conclusão

✅ **Solução implementada com sucesso**
- Steps são carregados corretamente do backend
- Mapeamento transparente no frontend
- Código existente não foi quebrado
- Frontend tem controle total sobre os dados
