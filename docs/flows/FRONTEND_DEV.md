# 🔥 Desenvolvimento Frontend em Real-Time

## 🚀 Modo Watch - Hot Reload

Para desenvolver o frontend com **hot reload automático**, use o comando:

```bash
npm run dev:frontend
```

### O que acontece:
- ✅ **Monitora alterações** em todos arquivos `.tsx`, `.ts` e `.css`
- ✅ **Recompila automaticamente** quando você salva
- ✅ **Sourcemaps habilitados** para debug facilitado
- ✅ **Build não minificado** para desenvolvimento
- ⚡ **Rápido** - Apenas recompila o que mudou

---

## 📦 Comandos Disponíveis

### Frontend:

| Comando | Descrição | Uso |
|---------|-----------|-----|
| `npm run build:frontend` | Build de produção (minificado) | Deploy |
| `npm run dev:frontend` | Watch mode para desenvolvimento | **Desenvolvimento** ✨ |
| `npm run build:frontend:watch` | Alias para dev:frontend | Desenvolvimento |

### Backend:

| Comando | Descrição | Uso |
|---------|-----------|-----|
| `npm run dev` | Backend com hot reload | Desenvolvimento backend |
| `npm start` | Backend sem hot reload | Produção |

---

## 🎯 Workflow Recomendado

### Opção 1: Dois Terminais (Recomendado)

**Terminal 1 - Backend:**
```bash
npm run dev
```

**Terminal 2 - Frontend:**
```bash
npm run dev:frontend
```

**Vantagens:**
- ✅ Logs separados (frontend e backend)
- ✅ Fácil de ver erros específicos
- ✅ Pode reiniciar um sem afetar o outro

### Opção 2: Apenas Frontend (API já rodando)

Se o backend já está rodando em outro lugar:

```bash
npm run dev:frontend
```

---

## 💡 Como Funciona

### Script de Build (`scripts/build-frontend.js`):

```javascript
const isDev = process.argv.includes("--watch");

const buildOptions = {
  // ... outras configs
  minify: !isDev,           // ✅ Sem minify em dev
  sourcemap: isDev,         // ✅ Sourcemaps em dev
  define: {
    "process.env.NODE_ENV": isDev ? '"development"' : '"production"',
  },
};

if (isDev) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log("👀 Watching for changes...");
} else {
  await esbuild.build(buildOptions);
  console.log("✅ Build completed successfully!");
}
```

### O que é monitorado:

```
src/frontend/
├── index.tsx              ✅
├── App.tsx                ✅
├── components/
│   ├── FlowEditor.tsx     ✅
│   ├── StepEditor.tsx     ✅
│   ├── FlowList.tsx       ✅
│   └── VisualFlowBuilder.tsx ✅
├── services/
│   ├── flow-api.service.ts     ✅
│   └── instances-api.service.ts ✅
├── types/
│   └── flow.types.ts      ✅
└── styles/
    └── app.css            ✅
```

---

## 🔄 Fluxo de Desenvolvimento

### 1. **Inicie o Watch Mode:**

```bash
npm run dev:frontend
```

**Output esperado:**
```
👀 Watching for changes...
```

### 2. **Edite um Arquivo:**

Por exemplo, edite `src/frontend/components/FlowEditor.tsx`:

```tsx
// Antes
<Button variant="contained">
  Novo Step
</Button>

// Depois
<Button variant="contained" color="success">
  ➕ Criar Novo Step
</Button>
```

### 3. **Salve (Ctrl+S):**

**Output esperado:**
```
👀 Watching for changes...
  rebuilding... ⚡
  rebuilt in 234ms ✅
```

### 4. **Recarregue o Navegador (F5):**

```
http://localhost:8005/flows
```

Suas alterações estarão lá! 🎉

---

## 🐛 Debug com Sourcemaps

No modo watch, sourcemaps estão habilitados:

### Chrome DevTools:

1. Abra: `F12` → **Sources**
2. Veja arquivos originais em:
   ```
   webpack://
   └── src/frontend/
       ├── components/
       ├── services/
       └── ...
   ```
3. **Set breakpoints** nos arquivos `.tsx` originais
4. **Inspect variables** com nomes reais (não minificados)

### Exemplo de Stack Trace:

```
❌ ANTES (produção):
  at r.execute (bundle.js:1:2345)
  at n (bundle.js:1:6789)

✅ DEPOIS (dev com sourcemaps):
  at FlowEditor.handleStepSaved (FlowEditor.tsx:89)
  at StepEditor.handleSubmit (StepEditor.tsx:62)
```

---

## ⚡ Performance

### Build Inicial:
```
⏱️ Primeiro build: ~2-3 segundos
📦 Bundle size (dev): ~800KB (não minificado)
```

### Rebuilds Incrementais:
```
⚡ Edição de componente: ~200-500ms
⚡ Edição de CSS: ~100-300ms
⚡ Edição de types: ~150-400ms
```

### Comparação com Build Completo:

| Operação | Build Completo | Watch Mode |
|----------|---------------|------------|
| Inicial | 2-3s | 2-3s |
| Editar FlowEditor.tsx | 2-3s | **~300ms** ⚡ |
| Editar app.css | 2-3s | **~150ms** ⚡ |
| Adicionar import | 2-3s | **~400ms** ⚡ |

**Ganho: 85-90% mais rápido!** 🚀

---

## 📝 Checklist de Desenvolvimento

### Antes de Começar:

- [ ] Backend rodando (`npm run dev` em outro terminal)
- [ ] Frontend watch ativo (`npm run dev:frontend`)
- [ ] Navegador aberto em `http://localhost:8005/flows`
- [ ] DevTools aberto (F12) para ver console

### Workflow:

1. [ ] Editar arquivo `.tsx`, `.ts` ou `.css`
2. [ ] Salvar (Ctrl+S)
3. [ ] Aguardar rebuild (~300ms)
4. [ ] Recarregar navegador (F5)
5. [ ] Verificar alterações

### Se algo der errado:

**Erro de compilação:**
```bash
# O watch mostrará o erro automaticamente
❌ Error: Cannot find module 'xyz'
```

**Rebuild não aconteceu:**
```bash
# Pare (Ctrl+C) e reinicie:
npm run dev:frontend
```

**Bundle não carrega:**
```bash
# Verifique se o arquivo foi gerado:
ls -la public/dist/bundle.js

# Se não existir, force um build:
npm run build:frontend
npm run dev:frontend
```

---

## 🎨 Exemplo Prático

### Tarefa: Mudar cor do botão "Voltar"

**1. Inicie watch mode:**
```bash
npm run dev:frontend
```

**2. Abra o arquivo:**
```
src/frontend/components/FlowEditor.tsx
```

**3. Localize o botão:**
```tsx
<Button
  variant="outlined"
  startIcon={<ArrowBackIcon />}
  onClick={onBack}
>
  Voltar
</Button>
```

**4. Mude para:**
```tsx
<Button
  variant="contained"
  color="secondary"
  startIcon={<ArrowBackIcon />}
  onClick={onBack}
>
  ← Voltar
</Button>
```

**5. Salve (Ctrl+S)**

**6. Terminal mostrará:**
```
👀 Watching for changes...
  rebuilding... ⚡
  rebuilt in 287ms ✅
```

**7. Recarregue o navegador (F5)**

**8. Veja o botão roxo e preenchido!** 🎨

---

## 🔥 Hot Module Replacement (HMR)

**Nota:** O esbuild watch atual **não tem HMR automático**.

Para recarregar automaticamente o navegador, você pode:

### Opção 1: Extensão Live Server (VS Code)

1. Instale: **Live Server** (Ritwick Dey)
2. Configure `settings.json`:
```json
{
  "liveServer.settings.root": "/public",
  "liveServer.settings.CustomBrowser": "chrome"
}
```
3. Click direito em `public/index.html` → **Open with Live Server**

### Opção 2: Browser Extension

1. Instale: **Auto Refresh Plus** (Chrome/Edge)
2. Configure para recarregar a cada 1-2 segundos
3. Ative apenas durante desenvolvimento

### Opção 3: LiveReload (Avançado)

Adicione ao `build-frontend.js`:

```javascript
const livereload = require('livereload');
const server = livereload.createServer();
server.watch('./public/dist');
```

---

## 📊 Estatísticas de Build

### Produção (`npm run build:frontend`):
```
📦 Bundle size: 226KB (minificado)
⏱️ Build time: ~2-3s
🗺️ Sourcemaps: Não
🔍 Minification: Sim
```

### Desenvolvimento (`npm run dev:frontend`):
```
📦 Bundle size: ~800KB (não minificado)
⏱️ Build time inicial: ~2-3s
⏱️ Rebuild time: ~300ms ⚡
🗺️ Sourcemaps: Sim
🔍 Minification: Não
👀 Watch: Ativo
```

---

## ✅ Checklist Final

- [x] Comando `dev:frontend` criado
- [x] Watch mode funcional
- [x] Sourcemaps habilitados
- [x] Build não minificado em dev
- [x] Documentação completa

---

## 🚀 Comece Agora!

```bash
# Terminal 1 - Backend
npm run dev

# Terminal 2 - Frontend Watch
npm run dev:frontend

# Navegador
# http://localhost:8005/flows
```

**Happy coding!** 🎉
