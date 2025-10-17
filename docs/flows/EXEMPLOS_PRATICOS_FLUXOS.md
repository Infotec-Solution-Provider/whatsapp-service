# 📖 Exemplos Práticos: Criando Fluxos Customizados

Este documento mostra exemplos práticos de como criar e gerenciar fluxos customizados usando o novo sistema.

## 🎯 Índice

1. [Criar Fluxo no Banco de Dados](#criar-fluxo-no-banco-de-dados)
2. [Exemplo 1: Fluxo VIP](#exemplo-1-fluxo-vip)
3. [Exemplo 2: Roteamento por Horário](#exemplo-2-roteamento-por-horário)
4. [Exemplo 3: Verificação de Campanha](#exemplo-3-verificação-de-campanha)
5. [Exemplo 4: Distribuição por Carga](#exemplo-4-distribuição-por-carga)
6. [Desabilitar/Habilitar Steps](#desabilitarhabilitar-steps)
7. [Consultar Steps Disponíveis](#consultar-steps-disponíveis)
8. [Métricas e Monitoramento](#métricas-e-monitoramento)

---

## Criar Fluxo no Banco de Dados

### Método 1: Via Prisma Client

```typescript
import prismaService from "./services/prisma.service";

// Criar fluxo completo
await prismaService.wppMessageFlow.create({
  data: {
    instance: "vollo",
    sectorId: 1,
    description: "Fluxo de Atendimento VIP",
    WppMessageFlowStep: {
      create: [
        {
          type: "CONDITION",
          stepNumber: 1,
          config: {
            field: "contact.isOnlyAdmin",
            operator: "equals",
            value: true,
            onTrue: 100,
            onFalse: 2
          },
          description: "Verifica se é admin",
          enabled: true
        },
        {
          type: "CHECK_AVAILABLE_USERS",
          stepNumber: 2,
          nextStepId: 3,
          description: "Distribui entre atendentes",
          enabled: true
        },
        {
          type: "SEND_TO_ADMIN",
          stepNumber: 3,
          config: {
            systemMessage: "Nenhum atendente disponível"
          },
          description: "Fallback para admin",
          enabled: true
        },
        {
          type: "ASSIGN",
          stepNumber: 100,
          config: {
            userId: -1,
            systemMessage: "Atendimento admin"
          },
          description: "Chat para admin",
          enabled: true
        }
      ]
    }
  }
});
```

### Método 2: Via SQL Direto

```sql
-- Criar o fluxo
INSERT INTO message_flows (instance, sector_id, description, created_at, updated_at)
VALUES ('vollo', 1, 'Fluxo VIP', NOW(), NOW())
RETURNING id;

-- Supondo que o ID retornado foi 10
INSERT INTO message_flows_steps 
  (message_flow_id, type, step_number, config, next_step_id, enabled, description, created_at, updated_at)
VALUES
  (10, 'CONDITION', 1, 
   '{"field": "contact.isOnlyAdmin", "operator": "equals", "value": true, "onTrue": 100, "onFalse": 2}'::jsonb,
   NULL, TRUE, 'Verifica se é admin', NOW(), NOW()),
  
  (10, 'CHECK_AVAILABLE_USERS', 2, '{}'::jsonb,
   3, TRUE, 'Distribui entre atendentes', NOW(), NOW()),
  
  (10, 'SEND_TO_ADMIN', 3, '{"systemMessage": "Nenhum atendente disponível"}'::jsonb,
   NULL, TRUE, 'Fallback para admin', NOW(), NOW()),
  
  (10, 'ASSIGN', 100, '{"userId": -1, "systemMessage": "Atendimento admin"}'::jsonb,
   NULL, TRUE, 'Chat para admin', NOW(), NOW());
```

---

## Exemplo 1: Fluxo VIP

Prioriza clientes VIP com atendimento dedicado.

```typescript
await prismaService.wppMessageFlow.create({
  data: {
    instance: "vollo",
    sectorId: 1,
    description: "Fluxo VIP com Priorização",
    WppMessageFlowStep: {
      create: [
        // Step 1: Buscar dados do cliente
        {
          type: "QUERY",
          stepNumber: 1,
          config: {
            query: "SELECT isVIP, OPERADOR FROM clientes WHERE CODIGO = ?",
            params: ["${contact.customerId}"],
            storeAs: "customerData",
            single: true
          },
          nextStepId: 2,
          description: "Busca informações do cliente",
          enabled: true
        },
        
        // Step 2: Verifica se é VIP
        {
          type: "CONDITION",
          stepNumber: 2,
          config: {
            field: "customerData.isVIP",
            operator: "equals",
            value: true,
            onTrue: 10,   // VIP vai para step 10
            onFalse: 3    // Não-VIP vai para step 3
          },
          description: "Rota VIPs para atendimento especial",
          enabled: true
        },
        
        // Step 3: Fluxo normal - verifica fidelização
        {
          type: "CHECK_LOALTY",
          stepNumber: 3,
          config: {
            checkIsOnline: true,
            checkIsActive: true
          },
          nextStepId: 4,
          fallbackStepId: 4,
          description: "Tenta atribuir ao operador fidelizado",
          enabled: true
        },
        
        // Step 4: Distribui por carga
        {
          type: "CHECK_AVAILABLE_USERS",
          stepNumber: 4,
          nextStepId: 5,
          description: "Distribui para atendente disponível",
          enabled: true
        },
        
        // Step 5: Fallback admin
        {
          type: "SEND_TO_ADMIN",
          stepNumber: 5,
          config: {
            systemMessage: "Nenhum atendente disponível"
          },
          description: "Admin quando não há atendentes",
          enabled: true
        },
        
        // Step 10: Atendimento VIP
        {
          type: "ASSIGN",
          stepNumber: 10,
          config: {
            userId: 5,  // Gerente de Contas VIP
            priority: "HIGH",
            systemMessage: "Cliente VIP - Atendimento Prioritário"
          },
          description: "Atendente VIP dedicado",
          enabled: true
        }
      ]
    }
  }
});
```

---

## Exemplo 2: Roteamento por Horário

Diferentes comportamentos dentro e fora do horário comercial.

```typescript
await prismaService.wppMessageFlow.create({
  data: {
    instance: "vollo",
    sectorId: 2,
    description: "Fluxo com Horário Comercial",
    WppMessageFlowStep: {
      create: [
        // Step 1: Verifica horário
        {
          type: "CONDITION",
          stepNumber: 1,
          config: {
            field: "system.currentHour",
            operator: "between",
            value: [8, 18],
            onTrue: 2,    // Dentro do horário
            onFalse: 100  // Fora do horário
          },
          description: "Verifica se está no horário comercial (8h-18h)",
          enabled: true
        },
        
        // Step 2: Verifica dia da semana
        {
          type: "CONDITION",
          stepNumber: 2,
          config: {
            field: "system.dayOfWeek",
            operator: "in",
            value: [1, 2, 3, 4, 5],  // Segunda a sexta
            onTrue: 3,
            onFalse: 100
          },
          description: "Verifica se é dia útil",
          enabled: true
        },
        
        // Step 3: Fluxo normal de atendimento
        {
          type: "CHECK_ONLY_ADMIN",
          stepNumber: 3,
          nextStepId: 4,
          description: "Verifica se é admin",
          enabled: true
        },
        
        {
          type: "CHECK_AVAILABLE_USERS",
          stepNumber: 4,
          nextStepId: 5,
          description: "Distribui entre atendentes",
          enabled: true
        },
        
        {
          type: "SEND_TO_ADMIN",
          stepNumber: 5,
          description: "Fallback admin",
          enabled: true
        },
        
        // Step 100: Mensagem fora do horário
        {
          type: "ASSIGN",
          stepNumber: 100,
          config: {
            userId: -1,
            systemMessage: "Estamos fora do horário de atendimento. " +
                          "Nosso horário é de segunda a sexta, das 8h às 18h. " +
                          "Retornaremos em breve!"
          },
          description: "Mensagem automática fora do horário",
          enabled: true
        }
      ]
    }
  }
});
```

---

## Exemplo 3: Verificação de Campanha

Roteia baseado no tipo de campanha do cliente.

```typescript
await prismaService.wppMessageFlow.create({
  data: {
    instance: "vollo",
    sectorId: 3,
    description: "Roteamento por Tipo de Campanha",
    WppMessageFlowStep: {
      create: [
        // Step 1: Busca tipo de campanha
        {
          type: "QUERY",
          stepNumber: 1,
          config: {
            query: `SELECT c.TIPO as TIPO_CAMPANHA 
                    FROM clientes cli 
                    LEFT JOIN campanhas c ON cli.COD_CAMPANHA = c.CODIGO 
                    WHERE cli.CODIGO = ?`,
            params: ["${contact.customerId}"],
            storeAs: "campaign",
            single: true,
            required: false
          },
          nextStepId: 2,
          fallbackStepId: 3,
          description: "Busca tipo de campanha do cliente",
          enabled: true
        },
        
        // Step 2: Roteia por tipo de campanha
        {
          type: "ROUTER",
          stepNumber: 2,
          config: {
            field: "campaign.TIPO_CAMPANHA",
            routes: {
              "INAT_A": 100,     // Inativos tipo A para supervisão
              "INAT_R": 100,     // Inativos tipo R para supervisão
              "ATIVO": 3,        // Ativos para fluxo normal
              "PROSPECT": 20,    // Prospects para comercial
              "default": 3       // Outros para fluxo normal
            }
          },
          description: "Roteia baseado no tipo de campanha",
          enabled: true
        },
        
        // Step 3: Fluxo normal
        {
          type: "CHECK_AVAILABLE_USERS",
          stepNumber: 3,
          nextStepId: 4,
          description: "Atendimento normal",
          enabled: true
        },
        
        {
          type: "SEND_TO_ADMIN",
          stepNumber: 4,
          description: "Admin fallback",
          enabled: true
        },
        
        // Step 20: Atendimento comercial
        {
          type: "ASSIGN",
          stepNumber: 20,
          config: {
            userId: 7,  // Equipe comercial
            priority: "NORMAL",
            systemMessage: "Prospect - Atendimento Comercial"
          },
          description: "Atendente comercial para prospects",
          enabled: true
        },
        
        // Step 100: Supervisão para inativos
        {
          type: "ASSIGN",
          stepNumber: 100,
          config: {
            userId: -1,
            priority: "LOW",
            systemMessage: "Cliente com campanha inativa - Requer análise da supervisão"
          },
          description: "Supervisão para campanhas inativas",
          enabled: true
        }
      ]
    }
  }
});
```

---

## Exemplo 4: Distribuição por Carga

Fluxo simples com balanceamento de carga.

```typescript
await prismaService.wppMessageFlow.create({
  data: {
    instance: "vollo",
    sectorId: 4,
    description: "Distribuição por Carga de Atendentes",
    WppMessageFlowStep: {
      create: [
        {
          type: "CHECK_ONLY_ADMIN",
          stepNumber: 1,
          nextStepId: 2,
          description: "Verifica admins",
          enabled: true
        },
        {
          type: "CHECK_LOALTY",
          stepNumber: 2,
          config: {
            checkIsOnline: true,
            checkIsActive: true
          },
          nextStepId: 3,
          description: "Tenta fidelização",
          enabled: true
        },
        {
          type: "CHECK_AVAILABLE_USERS",
          stepNumber: 3,
          nextStepId: 4,
          description: "Distribui por menor carga",
          enabled: true
        },
        {
          type: "SEND_TO_ADMIN",
          stepNumber: 4,
          config: {
            systemMessage: "Todos os atendentes estão ocupados"
          },
          description: "Admin quando todos ocupados",
          enabled: true
        }
      ]
    }
  }
});
```

---

## Desabilitar/Habilitar Steps

### Desabilitar um step temporariamente

```typescript
// Desabilitar verificação de fidelização
await prismaService.wppMessageFlowStep.update({
  where: {
    id: stepId
  },
  data: {
    enabled: false,
    description: "Desabilitado temporariamente para manutenção"
  }
});
```

### Desabilitar via SQL

```sql
-- Desabilitar step específico
UPDATE message_flows_steps 
SET enabled = FALSE,
    description = 'Desabilitado temporariamente'
WHERE id = 123;

-- Desabilitar todos os steps de um tipo
UPDATE message_flows_steps 
SET enabled = FALSE
WHERE type = 'CHECK_LOALTY';
```

---

## Consultar Steps Disponíveis

### Via TypeScript

```typescript
import { StepRegistry } from "./message-flow/step-registry";

// Listar todos os tipos disponíveis
const availableSteps = StepRegistry.getAvailableTypes();

console.log("Steps disponíveis:");
availableSteps.forEach(step => {
  console.log(`- ${step.type}: ${step.description}`);
  console.log(`  Config obrigatória: ${step.requiredConfig?.join(", ") || "nenhuma"}`);
  console.log(`  Config opcional: ${step.optionalConfig?.join(", ") || "nenhuma"}`);
});
```

### Criar Endpoint API

```typescript
// src/controllers/flow.controller.ts
import { Request, Response } from "express";
import { StepRegistry } from "../message-flow/step-registry";

export async function getAvailableSteps(req: Request, res: Response) {
  const steps = StepRegistry.getAvailableTypes();
  
  return res.json({
    steps: steps.map(s => ({
      type: s.type,
      description: s.description,
      requiredConfig: s.requiredConfig || [],
      optionalConfig: s.optionalConfig || []
    }))
  });
}
```

---

## Métricas e Monitoramento

### Inserir Métricas

```typescript
// Durante a execução de um step
const startTime = Date.now();

try {
  const result = await step.execute(context);
  const duration = Date.now() - startTime;
  
  // Registrar métrica de sucesso
  await prismaService.wppMessageFlowMetric.create({
    data: {
      flowId: 1,
      stepId: step.id,
      contactId: context.contact.id,
      duration,
      result: "success"
    }
  });
  
  return result;
} catch (error) {
  const duration = Date.now() - startTime;
  
  // Registrar métrica de falha
  await prismaService.wppMessageFlowMetric.create({
    data: {
      flowId: 1,
      stepId: step.id,
      contactId: context.contact.id,
      duration,
      result: "failure",
      error: error.message
    }
  });
  
  throw error;
}
```

### Consultar Métricas

```sql
-- Performance por step
SELECT 
  mfs.type,
  COUNT(*) as executions,
  AVG(mfm.duration_ms) as avg_duration_ms,
  MAX(mfm.duration_ms) as max_duration_ms,
  SUM(CASE WHEN mfm.result = 'success' THEN 1 ELSE 0 END)::FLOAT / COUNT(*) * 100 as success_rate
FROM message_flow_metrics mfm
JOIN message_flows_steps mfs ON mfm.step_id = mfs.id
WHERE mfm.timestamp > NOW() - INTERVAL '24 hours'
GROUP BY mfs.type
ORDER BY avg_duration_ms DESC;

-- Erros mais comuns
SELECT 
  mfs.type,
  mfm.error,
  COUNT(*) as occurrences
FROM message_flow_metrics mfm
JOIN message_flows_steps mfs ON mfm.step_id = mfs.id
WHERE mfm.result = 'failure'
  AND mfm.timestamp > NOW() - INTERVAL '7 days'
GROUP BY mfs.type, mfm.error
ORDER BY occurrences DESC
LIMIT 10;
```

---

## 🎓 Dicas e Boas Práticas

### 1. Sempre testar em desenvolvimento primeiro
```typescript
// Criar fluxo de teste
const testFlow = await prismaService.wppMessageFlow.create({
  data: {
    instance: "test",
    sectorId: 999,
    description: "TESTE - Não usar em produção"
    // ...
  }
});
```

### 2. Usar descrições claras
```typescript
{
  type: "CONDITION",
  description: "Verifica se cliente é VIP (isVIP = true) e roteia para atendimento prioritário"
}
```

### 3. Sempre configurar fallback
```typescript
{
  type: "QUERY",
  nextStepId: 2,
  fallbackStepId: 99,  // Step de erro
  config: {
    query: "...",
    required: true
  }
}
```

### 4. Documentar configurações complexas
```typescript
{
  type: "ROUTER",
  description: "Roteia por tipo de campanha:\n" +
              "- INAT_A/INAT_R: Supervisão\n" +
              "- ATIVO: Fluxo normal\n" +
              "- PROSPECT: Comercial",
  config: {
    // ...
  }
}
```

---

## 📚 Referências

- `ANALISE_MESSAGE_FLOW.md` - Análise completa
- `IMPLEMENTACAO_CONCLUIDA.md` - Status da implementação
- `GUIA_DECISAO_FLOW.md` - Quando refatorar
- `MIGRACAO_SCHEMA_FLOW.md` - Migração do banco

---

**Happy Coding! 🚀**
