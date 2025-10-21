# Fix: Step Data Rendering Incorretamente Após Update

## 🔴 Problema Identificado

Após atualizar um step (edit), os dados do formulário não eram sincronizados corretamente na re-renderização. Isso ocorria porque:

1. O `StepEditor` recebia o `step` prop atualizado do `FlowEditor`
2. Mas o `formData` local do `StepEditor` **NÃO** era atualizado automaticamente
3. Resultava em mostrar dados antigos ou incompletos no formulário

## 🔍 Causa Raiz

No arquivo `StepEditor.tsx`, havia apenas um `useEffect` que carregava os tipos de step, mas **nenhum** que sincronizasse o `formData` quando o `step` prop mudava:

```typescript
// ❌ ANTES - Faltava sincronização!
const [formData, setFormData] = useState({
    stepNumber: step?.stepNumber || ...,
    stepType: (step?.stepType || "QUERY") as ...,
    // ... outros campos inicializados apenas na criação do componente
});

useEffect(() => {
    loadStepTypes(); // Apenas carrega tipos
}, []);
```

**Problema**: Quando `step` prop mudava (após update), o estado `formData` não era atualizado!

## ✅ Solução Implementada

Adicionado um novo `useEffect` que sincroniza o `formData` sempre que o `step` prop muda:

```typescript
// ✅ DEPOIS - Sincronização automática
useEffect(() => {
    setFormData({
        stepNumber: step?.stepNumber || Math.max(0, ...steps.map((s) => s.stepNumber)) + 1,
        stepType: (step?.stepType || "QUERY") as WppMessageFlowStepType | "",
        nextStepId: step?.nextStepId?.toString() || "",
        fallbackStepId: step?.fallbackStepId?.toString() || "",
        description: step?.description || "",
        enabled: step?.enabled ?? true,
        config: step?.config || {},
        connections: step?.connections || null
    });
    setConfigJson(JSON.stringify(step?.config || {}, null, 2));
}, [step, steps]); // Dispara quando step OU steps mudam
```

## 🔄 Fluxo Completo (Agora Correto)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Usuário clica em "Editar Passo"                          │
│    FlowEditor: setSelectedStep(step) → renderiza StepEditor │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. StepEditor carrega com step prop                         │
│    useEffect [step, steps] → sincroniza formData            │
│    ✅ formData agora tem valores atualizados                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Usuário modifica dados e clica "Salvar"                  │
│    handleSubmit() → flowApiService.updateStep()             │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. Backend retorna step atualizado                          │
│    StepEditor: onSave(savedStep)                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 5. FlowEditor: handleStepSaved(savedStep)                   │
│    → setSteps() atualiza lista                              │
│    → setSelectedStep(null) fecha dialog                     │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ 6. Se usuário reeditar o mesmo step:                        │
│    → setSelectedStep(updatedStep)                           │
│    → useEffect [step] dispara                               │
│    → ✅ formData sincronizado com dados mais recentes       │
└─────────────────────────────────────────────────────────────┘
```

## 📝 Mudanças Específicas

**Arquivo**: `src/frontend/components/step-editor/StepEditor.tsx`

**Antes**:
```typescript
useEffect(() => {
    loadStepTypes();
}, []);
```

**Depois**:
```typescript
useEffect(() => {
    loadStepTypes();
}, []);

// Sincroniza formData quando o step prop muda (após update)
useEffect(() => {
    setFormData({
        stepNumber: step?.stepNumber || Math.max(0, ...steps.map((s) => s.stepNumber)) + 1,
        stepType: (step?.stepType || "QUERY") as WppMessageFlowStepType | "",
        nextStepId: step?.nextStepId?.toString() || "",
        fallbackStepId: step?.fallbackStepId?.toString() || "",
        description: step?.description || "",
        enabled: step?.enabled ?? true,
        config: step?.config || {},
        connections: step?.connections || null
    });
    setConfigJson(JSON.stringify(step?.config || {}, null, 2));
}, [step, steps]);
```

## 🧪 Casos de Teste

- ✅ Criar novo step → dados corretos
- ✅ Editar step → dados do step aparecem corretamente
- ✅ Salvar alterações → step atualizado no backend
- ✅ Reeditar o mesmo step → dados atualizados aparecem
- ✅ Modificar stepType → configurações adicionam/removem corretamente
- ✅ Dados de config mantêm sincronizados com JSON visual

## 💡 Lição Aprendida

Em React, quando um componente recebe props que são usadas para inicializar estado:

```typescript
// ❌ Ruim - Estado desincronizado
const [data, setData] = useState(initialProp);

// ✅ Bom - Estado sincronizado com prop
const [data, setData] = useState(initialProp);
useEffect(() => {
    setData(initialProp);
}, [initialProp]);
```

Esse padrão garante que mudanças na prop sejam refletidas no estado local.
