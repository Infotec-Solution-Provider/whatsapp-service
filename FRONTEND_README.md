# 🎨 Frontend Watch Mode - Quick Start

## ⚡ Desenvolvimento em Real-Time

Para editar o frontend e ver as alterações **automaticamente**:

### Opção 1: Frontend + Backend (Recomendado)

**Terminal 1:**
```bash
npm run dev
```

**Terminal 2:**
```bash
npm run dev:frontend
```

### Opção 2: Apenas Frontend

```bash
npm run dev:frontend
```

---

## 📝 O que o Watch Mode faz:

- ✅ **Monitora** todos arquivos `.tsx`, `.ts`, `.css`
- ✅ **Recompila** automaticamente ao salvar
- ✅ **Sourcemaps** para debug fácil
- ⚡ **Rápido** - rebuilds em ~300ms

---

## 🔄 Workflow:

1. Edite arquivo (ex: `src/frontend/components/FlowEditor.tsx`)
2. Salve (`Ctrl+S`)
3. Aguarde rebuild (~300ms)
4. Recarregue navegador (`F5`)
5. Veja suas alterações! 🎉

---

## 🌐 Acesse:

```
http://localhost:8005/flows
```

---

## 📚 Documentação Completa:

Ver: [`docs/flows/FRONTEND_DEV.md`](./docs/flows/FRONTEND_DEV.md)

- Debug com sourcemaps
- Exemplos práticos
- Troubleshooting
- Performance tips
