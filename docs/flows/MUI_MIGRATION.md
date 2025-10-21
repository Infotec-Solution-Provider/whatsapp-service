# 🎨 Migração para Material-UI (MUI)

## 📋 Resumo das Alterações

Todas as melhorias solicitadas foram implementadas com sucesso:

1. ✅ **Material-UI instalado** - Componentes padronizados e profissionais
2. ✅ **Instâncias dinâmicas** - Busca real via API (com fallback para mock)
3. ✅ **Inputs/Selects padronizados** - TextField, Select, Autocomplete do MUI
4. ✅ **Botões e ícones melhorados** - Button com ícones do @mui/icons-material

---

## 🚀 Componentes Refatorados

### 1. **App.tsx** - Interface Principal

#### Antes:
```tsx
<select value={instance} onChange={(e) => setInstance(e.target.value)}>
  <option value="vollo">Vollo</option>
  <option value="karsten">Karsten</option>
  <option value="exatron">Exatron</option>
  <option value="develop">Develop</option>
</select>
```

#### Depois:
```tsx
<Autocomplete
  value={selectedInstance || null}
  onChange={(_, newValue) => {
    if (newValue) {
      setInstance(newValue.clientName);
    }
  }}
  options={instances}
  getOptionLabel={(option) => option.name}
  loading={loadingInstances}
  renderInput={(params) => (
    <TextField
      {...params}
      label="Instância"
      size="small"
    />
  )}
/>
```

**Melhorias:**
- ✨ **Autocomplete** em vez de select nativo
- 🔄 **Busca dinâmica** de instâncias via API
- ⏳ **Loading indicator** integrado
- 🎨 **Tema Material-UI** com gradiente na AppBar

---

### 2. **FlowEditor.tsx** - Editor de Fluxos

#### Componentes MUI Utilizados:
- `Button` - Botões com ícones (ArrowBackIcon, AddIcon)
- `TextField` - Input de descrição do flow
- `Alert` - Mensagens de erro e sucesso (com dismiss)
- `Paper` - Cards com elevação
- `Grid` - Layout responsivo (7 colunas + 5 colunas)
- `Chip` - Stats de steps (configurados, ativos, desabilitados)
- `CircularProgress` - Loading spinner
- `Divider` - Separadores visuais

#### Destaques:

**Header com ações:**
```tsx
<Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
  <Button
    variant="outlined"
    startIcon={<ArrowBackIcon />}
    onClick={onBack}
  >
    Voltar
  </Button>
  
  <TextField
    label="Descrição"
    value={flow.description || ""}
    onChange={(e) => handleFlowUpdate({ description: e.target.value })}
    size="small"
    fullWidth
    sx={{ maxWidth: 500 }}
  />
  
  <Button
    variant="contained"
    startIcon={<AddIcon />}
    onClick={handleCreateStep}
  >
    Novo Step
  </Button>
</Box>
```

**Alerts com dismiss automático:**
```tsx
{error && (
  <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
    {error}
  </Alert>
)}

{successMessage && (
  <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccessMessage(null)}>
    {successMessage}
  </Alert>
)}
```

**Layout responsivo:**
```tsx
<Grid container spacing={3}>
  <Grid item xs={12} md={7}>
    {/* Visualização do Fluxo */}
  </Grid>
  
  <Grid item xs={12} md={5}>
    {/* Editor de Step */}
  </Grid>
</Grid>
```

---

### 3. **StepEditor.tsx** - Editor de Steps

#### Componentes MUI Utilizados:
- `Dialog` - Modal full-featured (em vez de div overlay)
- `DialogTitle`, `DialogContent`, `DialogActions`
- `TextField` - Inputs de texto e número
- `Select` + `MenuItem` - Dropdowns padronizados
- `FormControl` + `InputLabel` - Labels integrados
- `Switch` - Toggle de habilitado/desabilitado
- `Accordion` - Exemplos de configuração expansíveis
- `Grid` - Layout 8/4 para número e switch

#### Destaques:

**Dialog configurável:**
```tsx
<Dialog 
  open={true} 
  onClose={onCancel} 
  maxWidth="md" 
  fullWidth
  PaperProps={{
    sx: { minHeight: '80vh' }
  }}
>
  <DialogTitle>
    {step ? "Editar Step" : "Novo Step"}
  </DialogTitle>
  
  <DialogContent dividers>
    {/* Formulário */}
  </DialogContent>
  
  <DialogActions sx={{ px: 3, py: 2 }}>
    {/* Botões */}
  </DialogActions>
</Dialog>
```

**Switch em vez de checkbox:**
```tsx
<FormControlLabel
  control={
    <Switch
      checked={formData.enabled}
      onChange={(e) =>
        setFormData({ ...formData, enabled: e.target.checked })
      }
    />
  }
  label="Habilitado"
/>
```

**Select com label flutuante:**
```tsx
<FormControl fullWidth required>
  <InputLabel>Tipo de Step</InputLabel>
  <Select
    value={formData.stepType}
    label="Tipo de Step"
    onChange={(e) =>
      setFormData({
        ...formData,
        stepType: e.target.value as WppMessageFlowStepType,
      })
    }
  >
    {stepTypes.map((type) => (
      <MenuItem key={type.type} value={type.type}>
        {type.type} ({type.category})
      </MenuItem>
    ))}
  </Select>
  {selectedTypeInfo && (
    <FormHelperText>{selectedTypeInfo.description}</FormHelperText>
  )}
</FormControl>
```

**Accordion para exemplos:**
```tsx
<Accordion>
  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <MenuBookIcon fontSize="small" />
      <Typography>Exemplos de Configuração</Typography>
    </Box>
  </AccordionSummary>
  <AccordionDetails>
    {/* Exemplos de JSON */}
  </AccordionDetails>
</Accordion>
```

**Botões do Dialog:**
```tsx
<DialogActions sx={{ px: 3, py: 2 }}>
  <Button 
    onClick={onCancel} 
    startIcon={<CloseIcon />}
    color="inherit"
  >
    Cancelar
  </Button>
  
  <Box sx={{ flex: 1 }} /> {/* Spacer */}
  
  {step && onDelete && (
    <Button
      onClick={() => {
        if (confirm("Tem certeza que deseja deletar este step?")) {
          onDelete(step.id);
        }
      }}
      startIcon={<DeleteIcon />}
      color="error"
      variant="outlined"
    >
      Deletar
    </Button>
  )}
  
  <Button
    onClick={handleSubmit}
    startIcon={<SaveIcon />}
    variant="contained"
    color="primary"
  >
    {step ? "Salvar Alterações" : "Criar Step"}
  </Button>
</DialogActions>
```

---

### 4. **VisualFlowBuilder.tsx** - Visualização de Steps

#### Componentes MUI Utilizados:
- `Card` - Cards de steps com elevação dinâmica
- `CardContent`, `CardActions`
- `Chip` - Badges de número, tipo, status
- `Typography` - Textos padronizados
- `Stack` - Layout de chips
- `Divider` - Separadores
- `Box` - Container flexível

#### Destaques:

**Card interativo com elevação:**
```tsx
<Card
  elevation={selectedStepId === step.id ? 6 : 1}
  sx={{
    mb: 2,
    cursor: 'pointer',
    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
    border: selectedStepId === step.id ? '3px solid' : '2px solid transparent',
    borderColor: selectedStepId === step.id ? 'primary.main' : 'transparent',
    opacity: step.enabled ? 1 : 0.6,
    '&:hover': {
      transform: 'translateX(4px)',
      elevation: 4,
    }
  }}
  onClick={() => onStepSelect(step)}
>
```

**Chips informativos:**
```tsx
<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
  <Chip
    label={`#${step.stepNumber}`}
    size="small"
    color="primary"
    variant="filled"
  />
  <Chip
    label={step.stepType}
    size="small"
    color="secondary"
    variant="outlined"
  />
  {!step.enabled && (
    <Chip
      icon={<PauseIcon />}
      label="Desabilitado"
      size="small"
      color="warning"
      variant="filled"
    />
  )}
</Box>
```

**Footer com conexões:**
```tsx
<CardActions sx={{ justifyContent: 'space-between', px: 2, py: 1 }}>
  <Typography variant="caption" color="text.secondary">
    ID: {step.id}
  </Typography>
  <Stack direction="row" spacing={1}>
    {step.nextStepId && (
      <Chip
        icon={<ArrowForwardIcon />}
        label={`→ #${steps.find(s => s.id === step.nextStepId)?.stepNumber}`}
        size="small"
        variant="outlined"
        color="success"
      />
    )}
    {step.fallbackStepId && (
      <Chip
        icon={<SubdirectoryArrowLeftIcon />}
        label={`⤴ #${steps.find(s => s.id === step.fallbackStepId)?.stepNumber}`}
        size="small"
        variant="outlined"
        color="error"
      />
    )}
  </Stack>
</CardActions>
```

---

## 🔌 Integração com API de Instâncias

### Serviço Criado: `instances-api.service.ts`

```typescript
import axios from 'axios';

const INSTANCES_API_URL = (window as any).APP_CONFIG?.INSTANCES_API_URL || 'http://localhost:8000';
const AUTH_TOKEN = (window as any).APP_CONFIG?.AUTH_TOKEN || '';

export interface Instance {
  id: number;
  name: string;
  clientName: string;
  createdAt: string;
  updatedAt: string;
}

class InstancesApiService {
  private baseUrl = `${INSTANCES_API_URL}/api/instances`;

  async getAll(): Promise<Instance[]> {
    try {
      const response = await axios.get<InstancesResponse>(this.baseUrl, {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
        },
      });
      return response.data.data;
    } catch (error) {
      console.error('Erro ao buscar instâncias:', error);
      // Fallback para mock em caso de erro
      return [
        { id: 1, name: 'Vollo', clientName: 'vollo', ... },
        { id: 2, name: 'Karsten', clientName: 'karsten', ... },
        { id: 3, name: 'Exatron', clientName: 'exatron', ... },
        { id: 4, name: 'Develop', clientName: 'develop', ... },
      ];
    }
  }
}

export const instancesApiService = new InstancesApiService();
```

**Características:**
- ✅ Busca real via axios
- ✅ Headers de autenticação
- ✅ Fallback para mock (desenvolvimento sem API)
- ✅ Configuração via `window.APP_CONFIG`

---

## 🎨 Tema Material-UI

### Tema Personalizado:

```typescript
const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#667eea', // Roxo do gradiente original
    },
    secondary: {
      main: '#764ba2', // Roxo escuro do gradiente
    },
  },
});
```

### AppBar com Tema:

```tsx
<ThemeProvider theme={theme}>
  <CssBaseline />
  <AppBar position="static" elevation={2}>
    <Toolbar>
      <Typography variant="h5" component="h1" sx={{ flexGrow: 1, fontWeight: 600 }}>
        🤖 WhatsApp Message Flow Manager
      </Typography>
      {/* Autocomplete */}
    </Toolbar>
  </AppBar>
</ThemeProvider>
```

---

## 📦 Pacotes Instalados

```json
{
  "dependencies": {
    "@emotion/react": "^11.14.0",
    "@emotion/styled": "^11.14.1",
    "@mui/material": "^7.3.4",
    "@mui/icons-material": "^7.3.4",
    "axios": "^1.8.4" (já existia)
  }
}
```

**Total adicionado:** ~71 pacotes (MUI + dependências)

---

## 🎯 Ícones Utilizados

| Componente | Ícone | Uso |
|------------|-------|-----|
| **FlowEditor** | `ArrowBack` | Botão voltar |
| | `Add` | Criar novo step |
| **StepEditor** | `ExpandMore` | Accordion de exemplos |
| | `Save` | Salvar step |
| | `Delete` | Deletar step |
| | `Close` | Cancelar |
| | `MenuBook` | Ícone de exemplos |
| **VisualFlowBuilder** | `Pause` | Step desabilitado |
| | `ArrowForward` | Próximo step |
| | `SubdirectoryArrowLeft` | Fallback step |

---

## 📊 Comparação: Antes vs. Depois

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Inputs** | `<input>` nativo | `TextField` MUI |
| **Selects** | `<select>` nativo | `Select` + `MenuItem` MUI |
| **Botões** | Texto simples | `Button` com ícones |
| **Modal** | `div` overlay | `Dialog` MUI |
| **Cards** | `div` customizado | `Card` + `CardContent` |
| **Badges** | `span` customizado | `Chip` MUI |
| **Toggle** | `checkbox` | `Switch` MUI |
| **Loading** | Texto | `CircularProgress` MUI |
| **Alerts** | `div` customizado | `Alert` MUI |
| **Instâncias** | Hardcoded | API dinâmica |
| **Tema** | CSS customizado | `ThemeProvider` MUI |
| **Responsividade** | Media queries | `Grid` system |

---

## ✅ Checklist de Implementação

- [x] Instalar Material-UI e dependências
- [x] Criar serviço de instâncias via axios
- [x] Buscar instâncias reais no App.tsx
- [x] Refatorar FlowEditor com MUI
- [x] Refatorar StepEditor com MUI  
- [x] Refatorar VisualFlowBuilder com MUI
- [x] Rebuild frontend e testar
- [x] Build bem-sucedido ✅

---

## 🚀 Como Usar

### Desenvolvimento:

```bash
# Compilar frontend
npm run build:frontend

# Compilar e watch
npm run build:frontend:watch

# Iniciar servidor
npm run dev
```

### Acessar:

```
http://localhost:8005/flows
```

### Configurar API de Instâncias:

Para usar a API real em vez do mock, configure no HTML:

```html
<script>
  window.APP_CONFIG = {
    INSTANCES_API_URL: 'http://localhost:8000',
    AUTH_TOKEN: 'seu-token-aqui'
  };
</script>
```

---

## 🎨 Melhorias Visuais

### 1. **Consistência**
- Todos inputs com labels flutuantes
- Espaçamento padronizado (theme.spacing)
- Cores do tema aplicadas consistentemente

### 2. **Feedback Visual**
- Loading spinners em ações assíncronas
- Alerts com auto-dismiss (3 segundos)
- Elevação em cards selecionados
- Hover effects suaves

### 3. **Responsividade**
- Grid system do MUI
- Breakpoints automáticos (xs, md)
- Mobile-first approach

### 4. **Acessibilidade**
- Labels semânticos
- Contraste adequado
- Navegação por teclado (MUI built-in)
- ARIA attributes automáticos

---

## 📚 Documentação MUI

- **Material-UI**: https://mui.com/material-ui/
- **Icons**: https://mui.com/material-ui/material-icons/
- **Customização**: https://mui.com/material-ui/customization/theming/
- **Grid System**: https://mui.com/material-ui/react-grid/

---

## 🎉 Resultado Final

✅ **Interface profissional e moderna**  
✅ **Componentes padronizados**  
✅ **Busca dinâmica de instâncias**  
✅ **Ícones intuitivos**  
✅ **Tema consistente**  
✅ **Totalmente responsivo**  
✅ **Build bem-sucedido**

---

**Status**: ✅ **TODAS AS MELHORIAS IMPLEMENTADAS**  
**Build**: ✅ Compilado com sucesso  
**Pronto para uso**: http://localhost:8005/flows 🚀
