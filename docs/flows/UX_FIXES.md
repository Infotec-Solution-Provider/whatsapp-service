# 🔧 Correções de UX - StepEditor

## 📋 Problemas Corrigidos

### 1. ✅ Tipos de Step Exibindo Apenas "()"

**Problema:**
```tsx
<MenuItem key={type.type} value={type.type}>
  {type.type} ({type.category})  // ❌ category estava undefined
</MenuItem>
```

**Solução:**
```tsx
<MenuItem key={type.type} value={type.type}>
  {type.type}
  {type.category && ` (${type.category})`}  // ✅ Conditional rendering
</MenuItem>
```

**Resultado:**
- Agora exibe: `QUERY (generic)` ou apenas `SEND_TO_ADMIN` se não tiver categoria
- Sem parênteses vazios

---

### 2. ✅ Campos de Next/Fallback Step Muito Estreitos

**Problema:**
```tsx
<Grid container spacing={2}>
  <Grid item xs={6}>  // ❌ 50% da largura - muito estreito
    <FormControl fullWidth>
      <Select>
        <MenuItem>Step #1 - QUERY - Descrição muito longa...</MenuItem>
      </Select>
    </FormControl>
  </Grid>
  <Grid item xs={6}>  // ❌ 50% da largura
    ...
  </Grid>
</Grid>
```

**Solução:**
```tsx
{/* Layout em coluna única - 100% largura */}
<FormControl fullWidth>
  <InputLabel>Próximo Step (nextStepId)</InputLabel>
  <Select
    value={formData.nextStepId}
    label="Próximo Step (nextStepId)"
  >
    <MenuItem value="">Nenhum (fim do fluxo)</MenuItem>
    {steps.map((s) => (
      <MenuItem key={s.id} value={s.id}>
        Step #{s.stepNumber} - {s.stepType} {s.description && `(${s.description})`}
      </MenuItem>
    ))}
    <MenuItem value="new">➕ Será criado depois</MenuItem>
  </Select>
  <FormHelperText>Step que será executado após este</FormHelperText>
</FormControl>

<FormControl fullWidth>
  <InputLabel>Fallback Step (fallbackStepId)</InputLabel>
  <Select
    value={formData.fallbackStepId}
    label="Fallback Step (fallbackStepId)"
  >
    <MenuItem value="">Nenhum</MenuItem>
    {steps.map((s) => (
      <MenuItem key={s.id} value={s.id}>
        Step #{s.stepNumber} - {s.stepType} {s.description && `(${s.description})`}
      </MenuItem>
    ))}
    <MenuItem value="new">➕ Será criado depois</MenuItem>
  </Select>
  <FormHelperText>
    {selectedTypeInfo?.supportsFallback 
      ? "Step alternativo em caso de erro ou condição não atendida" 
      : "Step alternativo (nem todos os tipos suportam)"}
  </FormHelperText>
</FormControl>
```

**Melhorias:**
- ✅ **100% largura** - Muito mais legível
- ✅ **Descrição incluída** - `Step #1 - QUERY (Mensagem inicial)`
- ✅ **Helper text contextual** - Explica quando fallback é suportado
- ✅ **Layout vertical** - Melhor organização visual

---

### 3. ✅ Exemplos de Configuração Imprecisos

**Problema:**
Exemplos anteriores não correspondiam às interfaces reais dos steps:

```json
// ❌ ANTES - Exemplo incorreto de QUERY
{
  "text": "Olá! Como posso ajudar?"  // ❌ QUERY não tem campo "text"
}

// ❌ ANTES - Exemplo incorreto de ROUTER
{
  "options": [  // ❌ ROUTER não tem "options"
    { "key": "1", "stepId": 2, "label": "Suporte" }
  ]
}

// ❌ ANTES - Exemplo incorreto de ASSIGN
{
  "userId": 123,
  "message": "Transferindo..."  // ❌ Campo "message" não existe
}
```

**Solução:**
Exemplos baseados nas interfaces reais do código:

```tsx
<Accordion>
  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
    <MenuBookIcon fontSize="small" />
    <Typography>Exemplos de Configuração por Tipo</Typography>
  </AccordionSummary>
  <AccordionDetails>
    {/* QUERY - Interface real: QueryConfig */}
    <Box>
      <Typography variant="subtitle2" color="primary">
        QUERY - Executar Query SQL:
      </Typography>
      <Box component="pre" sx={{ bgcolor: 'grey.100', p: 1.5, borderRadius: 1 }}>
        {`{
  "query": "SELECT * FROM users WHERE id = ?",
  "params": ["\${contact.userId}"],
  "storeAs": "user",
  "single": true,
  "required": false
}`}
      </Box>
      <Typography variant="caption" color="text.secondary">
        Executa query e armazena resultado em context.user
      </Typography>
    </Box>

    {/* CONDITION - Interface real: ConditionConfig */}
    <Box>
      <Typography variant="subtitle2" color="primary">
        CONDITION - Avaliar Condição:
      </Typography>
      <Box component="pre" sx={{ bgcolor: 'grey.100', p: 1.5, borderRadius: 1 }}>
        {`{
  "field": "contact.isOnlyAdmin",
  "operator": "equals",
  "value": true,
  "onTrue": 5,
  "onFalse": 6
}`}
      </Box>
      <Typography variant="caption">
        Operadores: equals, notEquals, contains, in, gt, gte, lt, lte, exists, regex
      </Typography>
    </Box>

    {/* ROUTER - Interface real: RouterConfig */}
    <Box>
      <Typography variant="subtitle2" color="primary">
        ROUTER - Roteamento por Valor:
      </Typography>
      <Box component="pre" sx={{ bgcolor: 'grey.100', p: 1.5, borderRadius: 1 }}>
        {`{
  "field": "message.body",
  "routes": {
    "1": 10,
    "2": 20,
    "3": 30
  },
  "default": 99
}`}
      </Box>
      <Typography variant="caption">
        Mapeia valores para números de steps. Se não encontrar, usa default
      </Typography>
    </Box>

    {/* ASSIGN - Interface real: AssignConfig */}
    <Box>
      <Typography variant="subtitle2" color="primary">
        ASSIGN - Atribuir Chat:
      </Typography>
      <Box component="pre" sx={{ bgcolor: 'grey.100', p: 1.5, borderRadius: 1 }}>
        {`{
  "userId": 123,
  "walletId": null,
  "priority": "NORMAL",
  "systemMessage": "Chat atribuído a \${user.name}",
  "type": "RECEPTIVE"
}`}
      </Box>
      <Typography variant="caption">
        Atribui chat a usuário/carteira. userId -1 = admin. Suporta interpolação
      </Typography>
    </Box>

    {/* Steps Específicos */}
    <Box>
      <Typography variant="subtitle2" color="primary">
        Steps Específicos (sem config):
      </Typography>
      <Box component="pre" sx={{ bgcolor: 'grey.100', p: 1.5, borderRadius: 1 }}>
        {`// SEND_TO_ADMIN
{}

// CHECK_ONLY_ADMIN
{}

// CHECK_LOYALTY
{}

// CHECK_AVAILABLE_USERS
{}`}
      </Box>
      <Typography variant="caption">
        Steps específicos geralmente não precisam de configuração
      </Typography>
    </Box>
  </AccordionDetails>
</Accordion>
```

**Interfaces Reais Consultadas:**

```typescript
// src/message-flow/base/query.step.ts
interface QueryConfig {
  query: string;        // SQL query
  params?: any[];       // Parâmetros com interpolação
  storeAs: string;      // Nome da variável
  single?: boolean;     // Retorna apenas primeiro
  required?: boolean;   // Fallback se vazio
}

// src/message-flow/base/condition.step.ts
interface ConditionConfig {
  field: string;        // Campo a verificar
  operator: string;     // equals, contains, gt, lt, etc
  value: any;          // Valor para comparar
  onTrue: number;      // StepId se verdadeiro
  onFalse: number;     // StepId se falso
}

// src/message-flow/base/router.step.ts
interface RouterConfig {
  field: string;                    // Campo para avaliar
  routes: Record<string, number>;   // Mapa valor → stepNumber
  default?: number;                 // Step padrão
}

// src/message-flow/base/assign.step.ts
interface AssignConfig {
  userId?: number | string;         // ID do usuário ou interpolação
  walletId?: number | string;       // ID da carteira
  priority?: WppChatPriority;       // NORMAL, HIGH, etc
  systemMessage?: string;           // Mensagem do sistema
  type?: "RECEPTIVE" | "ACTIVE";   // Tipo do chat
}
```

**Melhorias nos Exemplos:**
- ✅ **Precisos** - Baseados nas interfaces reais
- ✅ **Completos** - Mostram todos os campos importantes
- ✅ **Documentados** - Captions explicativos
- ✅ **Organizados** - Separados por tipo com cores
- ✅ **Práticos** - Prontos para copiar e usar

---

## 📊 Comparação: Antes vs. Depois

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Tipos de Step** | `QUERY ()` ❌ | `QUERY` ou `QUERY (generic)` ✅ |
| **Largura Next/Fallback** | 50% (ilegível) ❌ | 100% (legível) ✅ |
| **Descrição nos Selects** | `Step #1 - QUERY` | `Step #1 - QUERY (Msg inicial)` ✅ |
| **Helper Text** | Fixo/genérico | Contextual e explicativo ✅ |
| **Exemplo QUERY** | `{ "text": "..." }` ❌ | `{ "query": "...", "storeAs": "..." }` ✅ |
| **Exemplo CONDITION** | Incompleto | `onTrue`, `onFalse` incluídos ✅ |
| **Exemplo ROUTER** | `options[]` (errado) ❌ | `routes{}` + `default` ✅ |
| **Exemplo ASSIGN** | `message` (inexistente) ❌ | `systemMessage`, `priority`, `type` ✅ |
| **Steps Específicos** | Não mencionados | Documentados ✅ |

---

## 🎯 Benefícios das Mudanças

### UX:
- ✅ **Legibilidade aumentada** - Campos com 100% largura
- ✅ **Menos confusão** - Tipos exibidos corretamente
- ✅ **Contexto melhor** - Descrições aparecem nos selects
- ✅ **Ajuda inline** - Helper text explica cada campo

### Documentação:
- ✅ **Exemplos precisos** - Baseados no código real
- ✅ **Aprendizado rápido** - Copy-paste direto
- ✅ **Reduz erros** - Usuários sabem os campos corretos
- ✅ **Autodocumentado** - Captions explicam cada config

### Manutenção:
- ✅ **Menos suporte** - Exemplos corretos = menos dúvidas
- ✅ **Validação implícita** - Usuários veem estrutura esperada
- ✅ **Consistência** - Alinhado com interfaces do backend

---

## 🔍 Código Fonte Consultado

Para garantir precisão, consultamos:

1. **Base Steps:**
   - `src/message-flow/base/query.step.ts`
   - `src/message-flow/base/condition.step.ts`
   - `src/message-flow/base/router.step.ts`
   - `src/message-flow/base/assign.step.ts`

2. **Specific Steps:**
   - `src/message-flow/steps/send-to-admin.step.ts`
   - `src/message-flow/steps/check-only-admin.step.ts`
   - `src/message-flow/steps/check-loyalty.step.ts`
   - `src/message-flow/steps/check-available-users.step.ts`

---

## ✅ Status

| Correção | Status |
|----------|--------|
| Tipos de step exibindo corretamente | ✅ Completo |
| Campos next/fallback com largura adequada | ✅ Completo |
| Exemplos de configuração precisos | ✅ Completo |
| Build | ⏳ Usuário executará |

---

**Pronto para build!** 🚀

Execute: `npm run build:frontend`
