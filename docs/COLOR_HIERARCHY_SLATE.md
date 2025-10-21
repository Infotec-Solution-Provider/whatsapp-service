# Hierarquia de Cores Slate - Frontend

## 📋 Visão Geral

O frontend foi redesenhado com uma hierarquia de cores usando a escala **Slate** do Tailwind/Material-UI, proporcionando melhor profundidade visual e hierarquia de informações.

## 🎨 Escala Slate Implementada

```
slate-50   → #f8fafc  (Fundo Principal)
slate-100  → #f1f5f9  (Seções Primárias)
slate-200  → #e2e8f0  (Sub-seções / Bordas)
slate-300  → #cbd5e1  (Elementos Interativos)
slate-400  → #94a3b8  (Texto Secundário)
slate-500  → #64748b  (Texto Médio)
slate-600  → #475569  (Texto Primário)
slate-700  → #334155  (Texto Forte)
slate-800  → #1e293b  (Títulos/Headers)
slate-900  → #0f172a  (Texto Máximo Contraste)
```

## 📍 Mapeamento por Camadas

### Camada 1: Fundo Principal (Slate-50)
- **Localização**: Fundo geral da aplicação
- **Componentes**: 
  - `App.tsx`: `bgcolor: "grey.50"` (minHeight: 100vh)
  - `FlowList.tsx`: Containers vazios
  - `StepEditor.tsx`: Fundo do Dialog

**Antes**:
```tsx
bgcolor: "background.default"
```

**Depois**:
```tsx
bgcolor: "grey.50"  // #f8fafc
```

---

### Camada 2: Seções Primárias (Slate-100)
- **Localização**: Seções principais, headers, stats
- **Componentes**:
  - `FlowEditor.tsx`: Header Paper, Stats Paper
  - `FlowList.tsx`: Barra de filtros/busca
  - `ConfigEditor.tsx`: Subseções de parâmetros
  - `StepEditor.tsx`: Accordion summary, DialogActions

**Exemplo**:
```tsx
<Paper elevation={1} sx={{ p: 3, mb: 3, bgcolor: "grey.100" }}>
  {/* Conteúdo */}
</Paper>
```

---

### Camada 3: Sub-seções (Slate-100/200)
- **Localização**: Editori de configurações, formulários
- **Componentes**:
  - `ConfigEditor.tsx`: Caixas de parâmetros e configuração
  - `ConnectionsEditor.tsx`: Box raiz com conexões
  - `StepEditor.tsx`: Config box e content dividers

**Exemplo**:
```tsx
<Box sx={{
  bgcolor: "grey.100",
  p: 2,
  borderRadius: 1,
  border: "1px solid",
  borderColor: "grey.300"
}}>
  {/* Configuração */}
</Box>
```

---

### Camada 4: Cards/Conteúdo (Slate-50 / White)
- **Localização**: Cards de fluxos, steps, diagramas
- **Componentes**:
  - `FlowCard.tsx`: Card fundo + CardContent branco
  - `FlowDiagram.tsx`: Card de steps

**Exemplo FlowCard**:
```tsx
<Card sx={{
  bgcolor: "grey.50",
  "&:hover": {
    bgcolor: "white"  // Transição ao hover
  }
}}>
  <CardContent sx={{ bgcolor: "white" }}>
    {/* Content */}
  </CardContent>
</Card>
```

---

### Camada 5: Bordas e Separadores (Slate-200/300)
- **Localização**: Dividers, borders, linhas
- **Componentes**:
  - `FlowDiagram.tsx`: `borderColor: "grey.300"`
  - `ConfigEditor.tsx`: `borderColor: "grey.300"`
  - Todos os `<Divider>`: Herdam de theme

**Antes**:
```tsx
borderColor: "divider"
```

**Depois**:
```tsx
borderColor: "grey.300"  // #cbd5e1
```

---

## 🏗️ Estrutura Visual Completa

```
┌─────────────────────────────────────────────────┐
│  App Background (slate-50: #f8fafc)             │
│                                                 │
│  ┌───────────────────────────────────────────┐  │
│  │ Section Header (slate-100: #f1f5f9)       │  │
│  │                                           │  │
│  │  ┌─────────────────────────────────────┐  │  │
│  │  │ Sub-Section (slate-100/200)         │  │  │
│  │  │                                     │  │  │
│  │  │  ┌──────────────────────────────┐   │  │  │
│  │  │  │ Content (white)              │   │  │  │
│  │  │  │ Dividers: slate-300          │   │  │  │
│  │  │  └──────────────────────────────┘   │  │  │
│  │  └─────────────────────────────────────┘  │  │
│  │                                           │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  Footer (slate-200: #e2e8f0)                   │
└─────────────────────────────────────────────────┘
```

---

## 📋 Checklist de Componentes Atualizados

### ✅ Completo
- [x] `App.tsx` - Tema + Colors pallete + Footer
- [x] `FlowList.tsx` - Background + Header + Empty state
- [x] `FlowCard.tsx` - Card colors + Hover effect
- [x] `FlowEditor.tsx` - Paper backgrounds + Sections
- [x] `FlowDiagram.tsx` - Card colors + Borders
- [x] `StepEditor.tsx` - Dialog background + Sections
- [x] `ConfigEditor.tsx` - Sub-sections + Boxes
- [x] `ConnectionsEditor.tsx` - Box backgrounds

### 🔄 Relacionados (Não alterados)
- `StepEditorFormBasic.tsx` - Herda do parent
- `StepEditorExamples.tsx` - Herda do parent
- `FlowEditorHeader.tsx` - Herda do parent
- `FlowEditorStats.tsx` - Herda do parent
- `FlowEditorAlerts.tsx` - Herda do parent
- `CreateFlowDialog.tsx` - Herda do parent

---

## 🎯 Benefícios da Hierarquia

1. **Profundidade Visual**: 4-5 camadas claras de fundo
2. **Contraste Melhorado**: Melhor legibilidade com slate vs branco puro
3. **Consistência**: Padrão único em toda a aplicação
4. **Acessibilidade**: Slate oferece melhor contraste que cinzas padrão
5. **Manutenibilidade**: Fácil ajustar através do theme centralizado

---

## 🔧 Como Usar o Theme

### Referência Direta
```tsx
sx={{ bgcolor: "grey.100" }}
sx={{ borderColor: "grey.300" }}
```

### Via Theme
```tsx
sx={{ 
  bgcolor: (theme) => theme.palette.grey[100],
  borderColor: (theme) => theme.palette.grey[300]
}}
```

---

## 📐 Proporções de Fundo

| Camada | Cor | Uso | Quantidade |
|--------|-----|-----|-----------|
| 1 | Slate-50 | Fundo geral | ~60% |
| 2 | Slate-100 | Headers/Sections | ~25% |
| 3 | Slate-200 | Bordas/Separadores | ~10% |
| 4 | White | Content | ~5% |

---

## ✨ Próximas Melhorias Sugeridas

1. **Hover States**: Adicionar transição suave entre camadas
2. **Dark Mode**: Implementar equivalente em dark mode
3. **Animations**: Transições suaves entre cores
4. **Shadows**: Refinar elevações com base em slate
5. **Accessibility**: WCAG AA compliance check

---

## 📝 Notas Técnicas

- **Material-UI Grey Palette**: Mapeada para Slate do Tailwind
- **CssBaseline**: Mantém background.default e background.paper
- **Inheritance**: Components herdam bgcolor do parent quando não especificado
- **Build**: ✅ Todas as mudanças compilam sem erros

---

**Data**: 17 de Outubro de 2025  
**Status**: ✅ Implementado e Testado  
**Build**: ✅ Sucesso (esbuild)
