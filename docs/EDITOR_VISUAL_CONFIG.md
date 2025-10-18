# Editor Visual de Configuração (ConfigEditor)

**Data:** 17 de outubro de 2025  
**Branch:** refactor/flow

## 📋 Resumo

Criado componente `ConfigEditor` que substitui a edição manual de JSON por interfaces visuais específicas para cada tipo de step, melhorando drasticamente a UX.

## 🎯 Motivação

**Problema Original:**
- Usuários precisavam digitar JSON manualmente
- Propenso a erros de sintaxe
- Difícil lembrar estrutura exata de cada tipo
- Não havia validação em tempo real
- Baixa usabilidade

**Solução:**
- Editor visual específico para cada tipo de step
- Campos apropriados (TextField, Select, Switch, etc.)
- Validação automática de tipos
- JSON atualiza automaticamente
- JSON ainda disponível para casos avançados (Accordion)

## 🎨 Componente ConfigEditor

### Localização
`src/frontend/components/ConfigEditor.tsx`

### Tipos Suportados

#### 1. **QUERY** - Executar SQL
**Campos:**
- `query` (TextField multiline) - Query SQL com suporte a `?` para parâmetros
- `storeAs` (TextField) - Nome da variável no contexto
- `params` (Array dinâmico) - Lista de parâmetros com botão Add/Remove
- `single` (Switch) - Retornar único registro
- `required` (Switch) - Obrigatório

**Exemplo Visual:**
```
┌─────────────────────────────────────────┐
│ Query SQL                               │
│ ┌─────────────────────────────────────┐ │
│ │ SELECT * FROM users WHERE id = ?    │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Armazenar Como                          │
│ ┌─────────────────────────────────────┐ │
│ │ user                                │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Parâmetros                              │
│ ┌────────────────────────────┐ [X]     │
│ │ ${contact.userId}          │         │
│ └────────────────────────────┘         │
│ [+ Adicionar Parâmetro]                │
│                                         │
│ ☑ Retornar um único registro           │
│ ☐ Obrigatório (erro se vazio)          │
└─────────────────────────────────────────┘
```

#### 2. **CONDITION** - Avaliar Condição
**Campos:**
- `field` (TextField) - Campo a avaliar
- `operator` (Select) - Operador de comparação
  - equals, notEquals, contains, in
  - gt, gte, lt, lte
  - exists, regex
- `value` (TextField) - Valor de comparação (auto-conversão de tipos)

**Features:**
- Auto-conversão: "true" → boolean, "123" → number
- Campo `value` oculto para operador "exists"
- Descrição de cada operador no Select

**Exemplo Visual:**
```
┌─────────────────────────────────────────┐
│ Campo a Avaliar                         │
│ ┌─────────────────────────────────────┐ │
│ │ contact.isOnlyAdmin                 │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Operador                                │
│ ┌─────────────────────────────────────┐ │
│ │ Igual (=)                    ▼     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Valor de Comparação                     │
│ ┌─────────────────────────────────────┐ │
│ │ true                                │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 3. **ROUTER** - Roteamento
**Campos:**
- `field` (TextField) - Campo cujo valor será usado para rotear

**Nota:**
- Rotas configuradas via `ConnectionsEditor`
- Alert informativo sobre onde configurar rotas

**Exemplo Visual:**
```
┌─────────────────────────────────────────┐
│ Campo a Avaliar                         │
│ ┌─────────────────────────────────────┐ │
│ │ message.body                        │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ℹ As rotas são configuradas na seção   │
│   "Conexões Condicionais" acima.       │
└─────────────────────────────────────────┘
```

#### 4. **ASSIGN** - Atribuir Chat
**Campos:**
- `userId` (TextField) - ID do usuário (-1 para admin)
- `walletId` (TextField) - ID da carteira (opcional)
- `priority` (Select) - LOW, NORMAL, HIGH, URGENT
- `type` (Select) - RECEPTIVE, ACTIVE, INTERNAL
- `systemMessage` (TextField multiline) - Mensagem com interpolação

**Features:**
- Auto-conversão de userId para número
- Suporte a interpolação ${variavel}

**Exemplo Visual:**
```
┌─────────────────────────────────────────┐
│ ID do Usuário                           │
│ ┌─────────────────────────────────────┐ │
│ │ -1                                  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Prioridade                              │
│ ┌─────────────────────────────────────┐ │
│ │ Normal                       ▼     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Tipo de Chat                            │
│ ┌─────────────────────────────────────┐ │
│ │ Receptivo                    ▼     │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ Mensagem do Sistema                     │
│ ┌─────────────────────────────────────┐ │
│ │ Chat atribuído ao admin             │ │
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 5. **Steps Específicos** (sem config)
**Steps:**
- SEND_TO_ADMIN
- CHECK_ONLY_ADMIN
- CHECK_LOALTY
- CHECK_AVAILABLE_USERS
- SELLER_MENU, CHOOSE_SELLER
- CHECK_NEED_TRANSFER
- ADMIN_MENU, CHOOSE_SECTOR, CHOOSE_AGENT
- SATISFACTION

**Comportamento:**
- Alert informativo: "Este tipo não requer configuração"
- Config permanece vazio ({})

## 🔄 Integração com StepEditor

### Mudanças no StepEditor.tsx

**1. Novo callback:**
```typescript
const handleConfigEditorChange = (config: Record<string, any>) => {
  setFormData({ ...formData, config });
  setConfigJson(JSON.stringify(config, null, 2)); // Sincroniza JSON
};
```

**2. Editor Visual (sempre visível):**
```tsx
<Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, p: 2 }}>
  <ConfigEditor
    stepType={formData.stepType}
    config={formData.config}
    onChange={handleConfigEditorChange}
  />
</Box>
```

**3. JSON Manual (Accordion - opcional):**
```tsx
<Accordion>
  <AccordionSummary>⚙️ Configuração JSON (Avançado)</AccordionSummary>
  <AccordionDetails>
    <TextField multiline rows={12} value={configJson} />
  </AccordionDetails>
</Accordion>
```

### Fluxo Bidirecional

**Editor Visual → JSON:**
- Usuário preenche campos visuais
- `handleConfigEditorChange` atualiza `config` e `configJson`
- JSON é sincronizado automaticamente

**JSON → Editor Visual:**
- Usuário edita JSON manualmente (Accordion)
- `handleConfigChange` atualiza `config`
- Editor visual reflete mudanças (controlled components)

## ✅ Benefícios

### UX
1. **Intuitivo:** Campos com labels descritivos
2. **Validação:** Conversão automática de tipos
3. **Ajuda contextual:** Placeholders e helperText
4. **Sem erros de sintaxe:** JSON gerado automaticamente
5. **Flexibilidade:** JSON ainda disponível para casos avançados

### Desenvolvimento
1. **Manutenível:** Cada tipo isolado em sua lógica
2. **Extensível:** Fácil adicionar novos tipos
3. **Tipado:** TypeScript garante estrutura correta
4. **Reusável:** ConfigEditor pode ser usado em outros lugares

### Usuário Final
1. **Não precisa conhecer JSON**
2. **Não precisa decorar estruturas**
3. **Feedback visual imediato**
4. **Menos erros**
5. **Mais produtivo**

## 🧪 Casos de Uso

### Criar Query
1. Seleciona tipo "QUERY"
2. Digita SQL: `SELECT * FROM users WHERE id = ?`
3. Adiciona parâmetro: `${contact.userId}`
4. Define storeAs: `user`
5. Marca "Retornar único registro"
6. JSON gerado automaticamente ✨

### Criar Condição
1. Seleciona tipo "CONDITION"
2. Campo: `contact.isOnlyAdmin`
3. Operador: `Igual (=)`
4. Valor: `true` (auto-convertido para boolean)
5. Configura onTrue/onFalse no ConnectionsEditor
6. Pronto! ✨

### Edição Avançada
1. Preenche via editor visual
2. Abre Accordion "JSON Avançado"
3. Edita JSON diretamente (se necessário)
4. Editor visual atualiza automaticamente
5. Melhor dos dois mundos! ✨

## 📝 Notas Técnicas

### Auto-conversão de Tipos
```typescript
// TextField do valor em CONDITION
onChange={(e) => {
  let value: any = e.target.value;
  if (value === "true") value = true;
  else if (value === "false") value = false;
  else if (!isNaN(Number(value)) && value !== "") value = Number(value);
  updateField("value", value);
}}
```

### Parâmetros Dinâmicos
```typescript
const addParam = () => {
  updateField("params", [...params, ""]);
};

const removeParam = (index: number) => {
  const newParams = params.filter((_, i) => i !== index);
  updateField("params", newParams);
};
```

### Sincronização Bidirecional
```typescript
// Visual → JSON
const handleConfigEditorChange = (config) => {
  setFormData({ ...formData, config });
  setConfigJson(JSON.stringify(config, null, 2));
};

// JSON → Visual
const handleConfigChange = (value) => {
  setConfigJson(value);
  try {
    const parsed = JSON.parse(value);
    setFormData({ ...formData, config: parsed });
  } catch {}
};
```

## 🚀 Próximos Passos

### Melhorias Futuras
1. **Validação em tempo real** com feedback visual de erros
2. **Autocompletar** para nomes de campos (contact., user., etc.)
3. **Preview** do resultado esperado
4. **Templates** pré-configurados por tipo
5. **Histórico** de configurações recentes
6. **Import/Export** de configurações

### Novos Tipos
Quando adicionar novos step types:
1. Adicione case no ConfigEditor
2. Crie campos apropriados
3. Documente estrutura JSON
4. Testes com usuários

## 📚 Arquivos Criados/Modificados

### Novo
- `src/frontend/components/ConfigEditor.tsx` - **NOVO** Editor visual

### Modificados
- `src/frontend/components/StepEditor.tsx` - Integração do ConfigEditor
- `docs/EDITOR_VISUAL_CONFIG.md` - **ESTE ARQUIVO**

## 🎓 Exemplos de Uso

### QUERY com múltiplos parâmetros
```typescript
// Visual:
Query: "SELECT * FROM messages WHERE chatId = ? AND userId = ?"
Params: ["${chat.id}", "${user.id}"]
StoreAs: "messages"
Single: false
Required: true

// JSON gerado:
{
  "query": "SELECT * FROM messages WHERE chatId = ? AND userId = ?",
  "params": ["${chat.id}", "${user.id}"],
  "storeAs": "messages",
  "single": false,
  "required": true
}
```

### CONDITION com regex
```typescript
// Visual:
Campo: "message.body"
Operador: "RegEx"
Valor: "^[0-9]{11}$"

// JSON gerado:
{
  "field": "message.body",
  "operator": "regex",
  "value": "^[0-9]{11}$"
}
```

### ASSIGN completo
```typescript
// Visual:
UserId: -1
Priority: "Alta"
Type: "Receptivo"
SystemMessage: "Chat atribuído ao admin"

// JSON gerado:
{
  "userId": -1,
  "walletId": null,
  "priority": "HIGH",
  "type": "RECEPTIVE",
  "systemMessage": "Chat atribuído ao admin"
}
```

---

**Resultado:** Interface moderna, intuitiva e profissional que eleva a experiência do usuário ao próximo nível! 🎯✨
