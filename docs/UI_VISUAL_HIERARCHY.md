# Hierarquia Visual - Melhorias de UX

## Objetivo
Criar diferenciação visual clara entre seções e componentes do editor de fluxos, facilitando a leitura e compreensão da estrutura da interface.

## Problema Anterior
- Todos os fundos eram brancos
- Sem variação de cinza para diferenciar seções
- Difícil identificar visualmente a hierarquia de informações
- Interface "plana" sem profundidade visual

## Solução Implementada

### 1. Paleta de Cores para Superfícies

Seguindo princípios do Material Design de elevação e superfície:

| Uso | Cor MUI | Descrição |
|-----|---------|-----------|
| **Seções principais** | `grey.50` | Fundo cinza claro para containers principais |
| **Subseções** | `background.paper` | Fundo branco com bordas para subseções |
| **Conteúdo base** | `background.default` | Fundo padrão do tema |
| **Cabeçalho** | `primary.main` | Azul primário para títulos de diálogo |
| **Rodapé** | `grey.50` | Cinza claro para rodapé de ações |
| **Seção especial** | `info.lighter` | Azul claro para seções de conexões |

### 2. ConfigEditor.tsx

#### Seção QUERY
```tsx
<Box sx={{ bgcolor: "grey.50", p: 2, borderRadius: 1 }}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    📝 Query SQL
  </Typography>
  {/* TextField para SQL */}
  
  {/* Subseção de Parâmetros */}
  <Box sx={{ bgcolor: "background.paper", border: "1px solid", borderColor: "divider", p: 2, borderRadius: 1 }}>
    <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
      🔗 Parâmetros Dinâmicos
    </Typography>
    {/* Array de parâmetros */}
  </Box>
</Box>
```

**Elementos visuais:**
- 📝 Ícone de edição para Query
- 🔗 Ícone de link para parâmetros
- Cor primary.main nos títulos
- Fundo grey.50 na seção principal
- Fundo background.paper com borda nas subseções

#### Seção CONDITION
```tsx
<Box sx={{ bgcolor: "grey.50", p: 2, borderRadius: 1 }}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    🔀 Condição
  </Typography>
  {/* Campos de condição */}
</Box>
```

**Elementos visuais:**
- 🔀 Ícone de bifurcação para condições
- Layout em 3 colunas: campo, operador, valor

#### Seção ROUTER
```tsx
<Box sx={{ bgcolor: "grey.50", p: 2, borderRadius: 1 }}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    🔄 Roteamento Dinâmico
  </Typography>
  {/* Campos de roteamento */}
</Box>
```

**Elementos visuais:**
- 🔄 Ícone de rotação para roteamento
- Alert informativo sobre ConnectionsEditor

#### Seção ASSIGN
```tsx
<Box sx={{ bgcolor: "grey.50", p: 2, borderRadius: 1 }}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    👤 Atribuição
  </Typography>
  {/* Campos de atribuição */}
</Box>
```

**Elementos visuais:**
- 👤 Ícone de pessoa para atribuição
- Layout em 2 colunas para userId e walletId

### 3. StepEditor.tsx

#### Cabeçalho do Diálogo
```tsx
<DialogTitle sx={{ 
  bgcolor: "primary.main", 
  color: "primary.contrastText", 
  borderBottom: "1px solid", 
  borderColor: "divider" 
}}>
  {step ? "✏️ Editar Step" : "➕ Novo Step"}
</DialogTitle>
```

**Elementos visuais:**
- Fundo azul primário
- Texto branco (contrastText)
- ✏️ Ícone de edição para modo edição
- ➕ Ícone de adição para modo criação
- Borda inferior para separação

#### Seção de Conexões Condicionais
```tsx
<Box sx={{ 
  bgcolor: "info.lighter", 
  border: "1px solid", 
  borderColor: "info.light", 
  borderRadius: 1, 
  p: 2 
}}>
  <Typography sx={{ fontWeight: 600, color: "info.main", mb: 2 }}>
    🔗 Conexões Condicionais
  </Typography>
  <ConnectionsEditor {...} />
</Box>
```

**Elementos visuais:**
- Fundo azul claro (info.lighter) para destaque
- Borda azul clara (info.light)
- 🔗 Ícone de conexões
- Cor info.main no título

#### Editor Visual de Configuração
```tsx
<Box sx={{ 
  bgcolor: "background.default", 
  border: "1px solid", 
  borderColor: "divider", 
  borderRadius: 1, 
  p: 2 
}}>
  <ConfigEditor {...} />
</Box>
```

**Elementos visuais:**
- Fundo padrão do tema
- Borda simples para delimitação

#### Accordion de JSON Avançado
```tsx
<Accordion sx={{ bgcolor: "grey.50" }}>
  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
    <Typography sx={{ fontWeight: 600, color: "warning.main" }}>
      ⚙️ Configuração JSON (Avançado)
    </Typography>
  </AccordionSummary>
  <AccordionDetails sx={{ bgcolor: "background.paper" }}>
    {/* TextField JSON */}
  </AccordionDetails>
</Accordion>
```

**Elementos visuais:**
- ⚙️ Ícone de engrenagem para configuração
- Cor warning.main (laranja) para indicar "avançado"
- Fundo grey.50 no header
- Fundo branco (background.paper) no conteúdo

#### Accordion de Exemplos
```tsx
<Accordion sx={{ bgcolor: "grey.50" }}>
  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <MenuBookIcon fontSize="small" />
      <Typography sx={{ fontWeight: 600, color: "info.main" }}>
        Exemplos de Configuração por Tipo
      </Typography>
    </Box>
  </AccordionSummary>
  <AccordionDetails sx={{ bgcolor: "background.paper" }}>
    {/* Exemplos */}
  </AccordionDetails>
</Accordion>
```

**Elementos visuais:**
- MenuBookIcon para documentação
- Cor info.main (azul) para conteúdo informativo
- Fundo grey.50 no header
- Fundo branco no conteúdo

#### Rodapé de Ações
```tsx
<DialogActions sx={{ 
  px: 3, 
  py: 2, 
  bgcolor: "grey.50", 
  borderTop: "1px solid", 
  borderColor: "divider" 
}}>
  <Button onClick={onCancel} startIcon={<CloseIcon />} color="inherit">
    Cancelar
  </Button>
  
  <Box sx={{ flex: 1 }} />
  
  {step && onDelete && (
    <Button startIcon={<DeleteIcon />} color="error" variant="outlined">
      Deletar
    </Button>
  )}
  
  <Button startIcon={<SaveIcon />} variant="contained" color="primary">
    {step ? "Salvar Alterações" : "Criar Step"}
  </Button>
</DialogActions>
```

**Elementos visuais:**
- Fundo grey.50 para separação do conteúdo
- Borda superior para delimitação
- Ícones nos botões (CloseIcon, DeleteIcon, SaveIcon)
- Separação dos botões com flex: 1

## Benefícios

### 1. Usabilidade
- ✅ Fácil identificar seções principais vs. subseções
- ✅ Hierarquia visual clara da informação
- ✅ Ícones ajudam no reconhecimento rápido de funcionalidades
- ✅ Cores diferenciadas para cada tipo de seção

### 2. Acessibilidade
- ✅ Contraste adequado entre texto e fundo
- ✅ Uso de ícones como apoio visual (não único indicador)
- ✅ Cores semânticas (warning para avançado, info para informativo)
- ✅ Bordas para delimitar áreas interativas

### 3. Consistência
- ✅ Padrão consistente de grey.50 para containers principais
- ✅ Padrão de background.paper para subseções
- ✅ Sempre uso de fontWeight: 600 para títulos
- ✅ Espaçamento consistente (p: 2, borderRadius: 1)

### 4. Profissionalismo
- ✅ Interface moderna seguindo Material Design
- ✅ Uso apropriado de elevação visual
- ✅ Ícones emoji discretos mas informativos
- ✅ Cores bem definidas e harmoniosas

## Antes e Depois

### Antes
```
┌─────────────────────────────────────┐
│ [Título]                            │ ← Tudo branco
├─────────────────────────────────────┤
│ Campo 1                             │
│ Campo 2                             │ ← Sem diferenciação
│ Campo 3                             │
│ Campo 4                             │
├─────────────────────────────────────┤
│ [Botões]                            │
└─────────────────────────────────────┘
```

### Depois
```
┌─────────────────────────────────────┐
│ 🎨 [Título em Azul]                 │ ← Destaque visual
├─────────────────────────────────────┤
│ 📝 Seção 1 (Cinza Claro)           │
│   ├─ Campo 1 (Branco com borda)    │ ← Hierarquia clara
│   └─ Campo 2 (Branco com borda)    │
│                                     │
│ 🔀 Seção 2 (Cinza Claro)           │ ← Ícones informativos
│   └─ Campo 3                       │
├─────────────────────────────────────┤
│ [Botões em Cinza Claro]            │ ← Rodapé diferenciado
└─────────────────────────────────────┘
```

## Padrões de Código

### Container Principal
```tsx
<Box sx={{ bgcolor: "grey.50", p: 2, borderRadius: 1 }}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    {emoji} Título
  </Typography>
  {/* Conteúdo */}
</Box>
```

### Subseção
```tsx
<Box sx={{ 
  bgcolor: "background.paper", 
  border: "1px solid", 
  borderColor: "divider", 
  p: 2, 
  borderRadius: 1 
}}>
  <Typography sx={{ fontWeight: 600, color: "primary.main" }}>
    {emoji} Subtítulo
  </Typography>
  {/* Conteúdo */}
</Box>
```

### Accordion
```tsx
<Accordion sx={{ bgcolor: "grey.50" }}>
  <AccordionSummary>
    <Typography sx={{ fontWeight: 600, color: "{semantic}.main" }}>
      {emoji} Título
    </Typography>
  </AccordionSummary>
  <AccordionDetails sx={{ bgcolor: "background.paper" }}>
    {/* Conteúdo */}
  </AccordionDetails>
</Accordion>
```

## Cores Semânticas Usadas

| Contexto | Cor | Uso |
|----------|-----|-----|
| **Principal** | `primary.main` | Seções padrão, cabeçalhos |
| **Informativo** | `info.main` | Documentação, ajuda |
| **Atenção** | `warning.main` | Funcionalidades avançadas |
| **Erro** | `error.main` | Ações destrutivas (deletar) |
| **Sucesso** | `success.main` | (Reservado para feedback) |

## Manutenção

Ao adicionar novas seções:

1. **Escolha o nível hierárquico:**
   - Seção principal → `bgcolor: "grey.50"`
   - Subseção → `bgcolor: "background.paper"` com borda

2. **Adicione um ícone emoji apropriado:**
   - 📝 Edição/texto
   - 🔀 Bifurcação/condição
   - 🔄 Rotação/ciclo
   - 👤 Usuário/pessoa
   - 🔗 Conexões/links
   - ⚙️ Configuração
   - 📚 Documentação

3. **Use cor semântica no título:**
   - `color: "primary.main"` (padrão)
   - `color: "info.main"` (informativo)
   - `color: "warning.main"` (avançado)

4. **Mantenha espaçamento consistente:**
   - `p: 2` para padding interno
   - `borderRadius: 1` para bordas arredondadas
   - `gap: 2` para espaçamento entre elementos

## Referências

- [Material Design - Elevation](https://m2.material.io/design/environment/elevation.html)
- [Material Design - Color System](https://m2.material.io/design/color/the-color-system.html)
- [MUI Theme - Palette](https://mui.com/material-ui/customization/palette/)
- [MUI - Box Component](https://mui.com/material-ui/react-box/)

---

**Data da implementação:** 2025-01-XX  
**Responsável:** Refatoração de UX do Editor de Fluxos  
**Status:** ✅ Completo
