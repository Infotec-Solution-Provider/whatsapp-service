# Implementação do FlowDiagram com ReactFlow

## 🎨 Migração para Diagrama Visual Interativo

Substituímos o componente `VisualFlowBuilder` por um **diagrama interativo** usando a biblioteca **ReactFlow**, transformando a visualização de lista estática em um **diagrama de fluxo profissional** com nodes e conexões visuais.

## 📦 Biblioteca Utilizada

### ReactFlow
- **Site:** https://reactflow.dev/
- **Versão:** Latest
- **Licença:** MIT
- **Descrição:** Biblioteca especializada em criar diagramas de fluxo interativos com React

**Instalação:**
```bash
npm install reactflow
```

## 🎯 Componente FlowDiagram

### Arquivo: `src/frontend/components/FlowDiagram.tsx`

### Funcionalidades Implementadas

#### 1. **Custom Nodes (Nós Customizados)**

Cada step é renderizado como um **MUI Paper** customizado:

```tsx
<Paper
  elevation={isSelected ? 6 : 2}
  sx={{
    p: 2,
    minWidth: 200,
    maxWidth: 300,
    border: isSelected ? 2 : 1,
    borderColor: isSelected ? "primary.main" : "divider",
    cursor: "pointer",
    transition: "all 0.2s",
    backgroundColor: step.enabled ? "background.paper" : "action.disabledBackground",
    "&:hover": {
      boxShadow: 6,
      borderColor: "primary.light",
    },
  }}
>
```

**Informações Exibidas:**
- ✅ Chip com número do step (`Step 1`, `Step 2`, etc.)
- ✅ Badge "Desabilitado" para steps inativos
- ✅ Tipo do step (QUERY, CONDITION, ROUTER, etc.)
- ✅ Descrição (se houver)
- ✅ Contador de configurações

**Estados Visuais:**
- **Selecionado:** Borda azul e elevação aumentada
- **Hover:** Box shadow aumentado e borda destacada
- **Desabilitado:** Background cinza claro

#### 2. **Conexões Visuais (Edges)**

##### Conexão Principal (nextStepId)
```tsx
{
  type: "smoothstep",
  animated: true, // Animação de fluxo
  style: { stroke: "#667eea", strokeWidth: 2 },
  label: "Próximo",
  labelStyle: { fill: "#667eea", fontWeight: 600 },
}
```

**Características:**
- Linha **azul** (`#667eea`)
- **Animada** (pontinhos se movendo)
- Label "Próximo"
- Tipo `smoothstep` (curvas suaves)

##### Conexão de Fallback (fallbackStepId)
```tsx
{
  type: "smoothstep",
  animated: false,
  style: { stroke: "#f59e0b", strokeWidth: 2, strokeDasharray: "5,5" },
  label: "Fallback",
  labelStyle: { fill: "#f59e0b", fontWeight: 600 },
}
```

**Características:**
- Linha **laranja** (`#f59e0b`)
- **Tracejada** (`strokeDasharray: "5,5"`)
- Label "Fallback"
- Tipo `smoothstep` (curvas suaves)

#### 3. **Layout Automático**

Layout em **grid responsivo**:

```typescript
position: {
  x: 50 + (index % 3) * 350,        // 3 colunas
  y: 50 + Math.floor(index / 3) * 180, // Espaçamento vertical
}
```

**Resultado:**
- **3 colunas** horizontais
- **Espaçamento:** 350px horizontal, 180px vertical
- **Margem:** 50px das bordas

#### 4. **Controles Interativos**

##### Background
```tsx
<Background 
  variant={BackgroundVariant.Dots} 
  gap={16} 
  size={1} 
  color="#e0e0e0" 
/>
```
- Grade de pontos cinza claro
- Ajuda a visualizar posicionamento

##### Controls
```tsx
<Controls />
```
- **Zoom In/Out**
- **Fit View** (ajustar para caber na tela)
- **Lock/Unlock** (travar interação)

##### MiniMap
```tsx
<MiniMap
  nodeColor={(node) => {
    const step = steps.find((s) => s.id.toString() === node.id);
    return step?.enabled ? "#667eea" : "#9e9e9e";
  }}
  style={{ backgroundColor: "#f5f5f5" }}
/>
```
- **Miniatura** do diagrama completo
- Nodes **azuis** para steps ativos
- Nodes **cinzas** para steps desabilitados
- Background cinza claro

#### 5. **Interação com Steps**

```typescript
const onNodeClick = useCallback(
  (_: any, node: Node) => {
    const step = steps.find((s) => s.id.toString() === node.id);
    if (step) {
      onStepSelect(step); // Abre modal de edição
    }
  },
  [steps, onStepSelect]
);
```

**Ao clicar em um node:**
1. Identifica o step
2. Chama `onStepSelect(step)`
3. Abre o `StepEditor` modal

## 🎨 Configuração Visual

### Área do Diagrama
```tsx
<Box sx={{ 
  height: 600, 
  width: "100%", 
  border: 1, 
  borderColor: "divider", 
  borderRadius: 1 
}}>
```

**Dimensões:**
- **Altura:** 600px
- **Largura:** 100% do container
- **Borda:** 1px cinza
- **Border radius:** 1 (cantos arredondados)

### Configurações do ReactFlow
```tsx
<ReactFlow
  nodes={nodes}
  edges={edges}
  onNodeClick={onNodeClick}
  nodeTypes={nodeTypes}
  fitView                     // Ajusta zoom inicial
  fitViewOptions={{ padding: 0.2 }}  // 20% de padding
  minZoom={0.5}              // Zoom mínimo 50%
  maxZoom={1.5}              // Zoom máximo 150%
>
```

## 📊 Exemplo de Fluxo Visual

```
┌─────────────┐
│   Step 1    │
│   QUERY     │──────Próximo──────┐
└─────────────┘                   │
       │                          │
       │ Fallback                 ▼
       │                    ┌─────────────┐
       │                    │   Step 2    │
       │                    │ CONDITION   │
       │                    └─────────────┘
       │                          │
       ▼                          │ Próximo
┌─────────────┐                   │
│   Step 3    │                   │
│   ASSIGN    │◄──────────────────┘
└─────────────┘
```

**Legenda:**
- Linha **azul contínua animada:** Próximo step
- Linha **laranja tracejada:** Fallback step

## 🚀 Vantagens sobre Lista Estática

### Antes (VisualFlowBuilder)
❌ Lista vertical de cards
❌ Sem visualização de conexões
❌ Difícil entender fluxo complexo
❌ Estático

### Depois (FlowDiagram com ReactFlow)
✅ **Diagrama visual interativo**
✅ **Conexões visíveis** (nextStep e fallback)
✅ **Zoom e pan** para navegar
✅ **MiniMap** para visão geral
✅ **Animações** nas conexões
✅ **Layout automático**
✅ **Hover effects**
✅ **Seleção visual** do step atual

## 🎯 Casos de Uso

### 1. Visualizar Fluxo Complexo
- Múltiplos steps conectados
- Ramificações (conditions)
- Fallbacks claros

### 2. Debug de Fluxos
- Ver todas as conexões de uma vez
- Identificar loops
- Verificar steps órfãos (sem conexões)

### 3. Apresentação
- Interface profissional
- Fácil de entender para não-técnicos
- Exportável (screenshot)

## 🔧 Customizações Futuras Sugeridas

### 1. Drag & Drop
```tsx
<ReactFlow
  nodesDraggable={true}
  // Salvar posições customizadas no backend
  onNodesChange={onNodesChange}
/>
```

### 2. Layout Algoritmos
```typescript
import { getLayoutedElements } from 'reactflow';

// Dagre layout
// Hierarchical layout
// Force-directed layout
```

### 3. Cores por Tipo de Step
```typescript
const getNodeColor = (stepType: string) => {
  switch (stepType) {
    case 'QUERY': return '#3b82f6';
    case 'CONDITION': return '#10b981';
    case 'ROUTER': return '#f59e0b';
    case 'ASSIGN': return '#8b5cf6';
    default: return '#667eea';
  }
};
```

### 4. Tooltips Avançados
```tsx
<Tooltip title={JSON.stringify(step.config, null, 2)}>
  <Paper>...</Paper>
</Tooltip>
```

### 5. Exportar Diagrama
```typescript
import { toPng } from 'html-to-image';

const downloadImage = () => {
  const nodeElement = document.querySelector('.react-flow');
  toPng(nodeElement).then((dataUrl) => {
    const link = document.createElement('a');
    link.download = 'flow-diagram.png';
    link.href = dataUrl;
    link.click();
  });
};
```

### 6. Validação Visual
- Steps sem nextStep (terminais) em verde
- Steps órfãos (sem incoming edges) em vermelho
- Loops detectados em laranja

## 📁 Arquivos Modificados

### Novos
- ✅ `src/frontend/components/FlowDiagram.tsx`
- ✅ `docs/REACTFLOW_IMPLEMENTATION.md`

### Modificados
- ✅ `src/frontend/components/FlowEditor.tsx` (substituiu VisualFlowBuilder por FlowDiagram)
- ✅ `package.json` (adicionou reactflow)

## 🎓 Recursos de Aprendizado

### Documentação
- https://reactflow.dev/learn
- https://reactflow.dev/examples

### Exemplos
- **Custom Nodes:** https://reactflow.dev/examples/nodes/custom-node
- **Edge Types:** https://reactflow.dev/examples/edges/edge-types
- **Layouting:** https://reactflow.dev/examples/layout/dagre

## 📊 Performance

### Otimizações Implementadas
```tsx
const nodes = useMemo(() => { ... }, [steps, selectedStepId]);
const edges = useMemo(() => { ... }, [steps]);
const onNodeClick = useCallback(() => { ... }, [steps, onStepSelect]);
```

- **useMemo** para nodes e edges (recalcula apenas quando steps mudam)
- **useCallback** para event handlers
- **Renderização eficiente** mesmo com 50+ steps

## 🎉 Resultado Final

Um **diagrama de fluxo profissional** que:
- ✅ Mostra visualmente todas as conexões
- ✅ Permite zoom e navegação
- ✅ Integra perfeitamente com MUI
- ✅ Abre modal de edição ao clicar
- ✅ Indica step selecionado visualmente
- ✅ Diferencia steps ativos/desabilitados
- ✅ Anima as conexões principais
- ✅ Mostra fallbacks com linha tracejada
- ✅ Fornece minimap para navegação
- ✅ Oferece controles de zoom

**Transformamos uma lista estática em um diagrama interativo e profissional! 🚀**
