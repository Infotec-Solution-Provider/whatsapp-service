# 🔍 Guia de Depuração - Logs do Step Editor

## Como Capturar os Logs

### 1. **Abrir DevTools do Navegador**
   - Pressione `F12` ou `Ctrl+Shift+I` (ou `Cmd+Option+I` no Mac)
   - Vá para a aba **Console**

### 2. **Realizar a Ação (Create/Edit Step)**
   - Abra o editor de step (novo ou editar)
   - Faça as alterações que desejar
   - Clique em "Salvar"

### 3. **Copiar os Logs**
   - Na aba Console, você verá mensagens em ordem:
     - `[StepEditor] Enviando dados do step:` 
     - `[StepEditor] Atualizando step existente:` ou `[StepEditor] Criando novo step no flow:`
     - `[StepEditor] Resposta do update:` ou `[StepEditor] Resposta do create:`
     - `[FlowEditor] handleStepSaved chamado:`
     - etc...

### 4. **Capturar os Logs**
   
**Opção A - Copiar direto do Console:**
- Selecione do primeiro `[StepEditor]` até o último log
- Copie (Ctrl+C) e cole aqui

**Opção B - Filtrar logs:**
- Na caixa de filtro, digite: `StepEditor`
- Depois vá filtrando outros
- Copie cada grupo

## O Que Cada Log Significa

### `[StepEditor] Enviando dados do step:`
Mostra o que está sendo **ENVIADO** para a API:
- `type:` Tipo do step (QUERY, CONDITION, etc)
- `stepNumber:` Número do passo
- `description:` Descrição (ou "(vazio)")
- `enabled:` True/False
- `nextStepId:` ID do próximo passo (ou "(vazio)")
- `fallbackStepId:` ID de fallback (ou "(vazio)")
- `config keys:` Quais campos estão na configuração

### `[StepEditor] Resposta do update/create:`
Mostra o que a API **RETORNOU**:
- Os mesmos campos acima
- Se algum estiver "(vazio)" aqui, significa que foi perdido na API

### `[FlowEditor] handleStepSaved chamado:`
Mostra que o step foi recebido no componente pai e está sendo atualizado

## 📋 Template para Cole Aqui

Por favor, **copie e cole os logs aqui** seguindo este padrão:

```
=== STEP EDITOR LOGS ===

[Cole todos os logs que começam com [StepEditor] ou [FlowEditor] aqui]

=== OBSERVAÇÕES ===

- Você estava criando ou editando?
- Quais campos foram modificados?
- Qual era o tipo do step (QUERY, CONDITION, etc)?
- Houve alguma mensagem de erro?

```

## 🎯 O Que Estou Procurando

Quero verificar:
1. ✅ Os dados estão sendo enviados corretamente?
2. ✅ A resposta da API contém todos os dados?
3. ✅ Quais campos estão sendo perdidos (se houver)?
4. ✅ Há erro em algum ponto da cadeia?

Com esses logs, poderei identificar **exatamente** onde os dados desaparecem! 🔎
