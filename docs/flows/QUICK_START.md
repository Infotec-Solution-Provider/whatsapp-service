# 🚀 Quick Start - Interface Web

## ⚡ 3 Passos para Começar

### 1️⃣ Iniciar o Servidor
```bash
npm run dev
```

### 2️⃣ Abrir no Navegador
```
http://localhost:8005/flows
```

### 3️⃣ Criar seu Primeiro Fluxo!

1. Clique em **"➕ Novo Fluxo"**
2. Preencha a descrição
3. Clique em **"Criar Fluxo"**
4. Adicione steps clicando em **"➕ Novo Step"**

---

## 📋 Exemplo Rápido

### Criar Fluxo de Boas-vindas

**Fluxo:**
- Descrição: "Fluxo de Boas-vindas"
- Instância: vollo
- Setor: (vazio)

**Step 1 - Mensagem de Boas-vindas:**
- Step Number: `1`
- Tipo: `QUERY`
- Próximo Step: `2`
- Config:
```json
{
  "text": "Olá! Bem-vindo ao atendimento. Como posso ajudar?"
}
```

**Step 2 - Atribuir ao Admin:**
- Step Number: `2`
- Tipo: `SEND_TO_ADMIN`
- Config:
```json
{
  "message": "Transferindo para atendente..."
}
```

---

## 🎯 Ações Rápidas

### Na Lista de Fluxos
- 🔍 **Buscar**: Digite no campo de busca
- ➕ **Criar**: Clique em "Novo Fluxo"
- ✏️ **Editar**: Clique no card do fluxo
- 🗑️ **Deletar**: Clique no ícone da lixeira
- 📋 **Duplicar**: Clique no ícone de copiar
- ⏸️ **Desabilitar**: Clique no ícone de pause

### No Editor de Fluxo
- 📋 **Lista**: Veja todos os steps em tabela
- 🌳 **Visual**: Veja o fluxo em árvore
- ➕ **Novo Step**: Adicione um step
- ✓ **Validar**: Verifique se o fluxo está correto
- ← **Voltar**: Retorne à lista

### No Editor de Step
- 📝 **Configurar**: Preencha os campos
- 💡 **Exemplos**: Clique em "Exemplos de Configuração"
- ✅ **Salvar**: Clique em "Criar Step" ou "Salvar Alterações"
- ❌ **Cancelar**: Clique em "Cancelar"

---

## 💡 Dicas Rápidas

1. **Use o modo visual** 🌳 para entender o fluxo
2. **Valide sempre** ✓ antes de habilitar
3. **Use descrições claras** 📝 nos steps
4. **Teste em dev primeiro** 🧪 antes de produção
5. **Duplique fluxos** 📋 que funcionam bem

---

## 🆘 Problemas Comuns

### Interface não carrega
```bash
npm run build:frontend
npm run dev
```

### Fluxo não executa
- ✅ Está habilitado?
- ✅ Steps estão habilitados?
- ✅ Clique em "✓ Validar Fluxo"

### Erro no JSON
- Use os exemplos clicando em "📖 Exemplos de Configuração"
- Copie e cole exemplos funcionais

---

## 📚 Documentação Completa

- [Guia da Interface](./WEB_INTERFACE.md)
- [Documentação dos Steps](./STEPS_DOCUMENTATION.md)
- [README Geral](./README_WEB.md)

---

**Acesse agora**: http://localhost:8005/flows 🚀
