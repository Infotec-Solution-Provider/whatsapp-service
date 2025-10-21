# 🌐 Interface Web para Gerenciamento de Message Flows

## 📋 Visão Geral

Este documento descreve a interface web completa criada para gerenciar os fluxos de mensagem do WhatsApp Service. A interface fornece uma maneira visual e prática de criar, editar e gerenciar fluxos sem precisar manipular SQL diretamente.

## 🎯 Funcionalidades

### 1. **Lista de Fluxos (FlowList)**
- ✅ Visualização de todos os fluxos de uma instância
- 🔍 Busca por descrição, ID ou setor
- ➕ Criação de novos fluxos
- ✏️ Edição de fluxos existentes
- 🗑️ Exclusão de fluxos
- 📋 Duplicação de fluxos para outras instâncias/setores
- ⏸️ Habilitar/desabilitar fluxos

### 2. **Editor de Fluxos (FlowEditor)**
- 📊 Visualização detalhada de todos os steps do fluxo
- ➕ Adição de novos steps
- ✏️ Edição de steps existentes
- 🗑️ Exclusão de steps
- ✓ Validação de integridade do fluxo
- 🌳 Visualização em lista ou modo visual
- ⏸️ Habilitar/desabilitar steps individuais

### 3. **Editor de Steps (StepEditor)**
- 🎨 Formulário completo para criar/editar steps
- 📝 Configuração JSON com editor de código
- 🔗 Seleção visual de next_step_id e fallback_step_id
- 📖 Exemplos de configuração para cada tipo de step
- ✅ Validação de JSON em tempo real
- 🏷️ Tipos de step disponíveis automaticamente da API

### 4. **Visualização Visual (VisualFlowBuilder)**
- 🌳 Representação em árvore do fluxo
- → Indicação visual de conexões (next e fallback)
- 🎨 Diferenciação de cores para steps habilitados/desabilitados
- 👁️ Preview da configuração de cada step

## 🚀 Como Usar

### Acessar a Interface

1. **Inicie o servidor backend:**
   ```bash
   npm run dev
   ```

2. **Em outro terminal, inicie o build do frontend em modo watch (opcional):**
   ```bash
   npm run build:frontend:watch
   ```

3. **Acesse a interface no navegador:**
   ```
   http://localhost:8005/flows
   ```

### Criar um Novo Fluxo

1. Acesse a interface web
2. Selecione a instância desejada no topo da página
3. Clique em "➕ Novo Fluxo"
4. Preencha a descrição e opcionalmente o ID do setor
5. Clique em "Criar Fluxo"

### Adicionar Steps ao Fluxo

1. Clique no card do fluxo desejado
2. Clique em "➕ Novo Step"
3. Configure:
   - **Step Number**: Número sequencial do step
   - **Tipo**: Selecione o tipo de step (QUERY, ROUTER, etc.)
   - **Descrição**: Descrição do que o step faz
   - **Próximo Step**: ID do próximo step ou deixe vazio
   - **Fallback Step**: ID do step de fallback (opcional)
   - **Configuração**: JSON com as configurações específicas do step
4. Clique em "Criar Step"

### Exemplo: Criar Fluxo de Atendimento Básico

**Step 1 - Mensagem de Boas-vindas (QUERY)**
```json
{
  "stepNumber": 1,
  "stepType": "QUERY",
  "nextStepId": 2,
  "description": "Mensagem de boas-vindas",
  "config": {
    "text": "Olá! Bem-vindo ao atendimento. Como posso ajudar?\n\n1 - Suporte\n2 - Vendas\n3 - Falar com atendente"
  }
}
```

**Step 2 - Roteamento (ROUTER)**
```json
{
  "stepNumber": 2,
  "stepType": "ROUTER",
  "description": "Rotear baseado na escolha",
  "config": {
    "options": [
      { "key": "1", "stepId": 3, "label": "Suporte" },
      { "key": "2", "stepId": 4, "label": "Vendas" },
      { "key": "3", "stepId": 5, "label": "Atendente" }
    ]
  }
}
```

**Step 3 - Mensagem de Suporte (QUERY)**
```json
{
  "stepNumber": 3,
  "stepType": "QUERY",
  "nextStepId": 5,
  "description": "Informações de suporte",
  "config": {
    "text": "📞 Suporte Técnico\n\nPara suporte, visite: https://suporte.exemplo.com\nOu aguarde que um atendente irá te auxiliar."
  }
}
```

## 🏗️ Arquitetura

### Estrutura de Arquivos

```
src/frontend/
├── App.tsx                    # Componente principal
├── index.tsx                  # Entry point
├── components/
│   ├── FlowList.tsx          # Lista de fluxos
│   ├── FlowEditor.tsx        # Editor de fluxo
│   ├── StepEditor.tsx        # Editor de step
│   └── VisualFlowBuilder.tsx # Visualização em árvore
├── services/
│   └── flow-api.service.ts   # Cliente da API REST
├── types/
│   └── flow.types.ts         # Tipos TypeScript
└── styles/
    └── app.css               # Estilos globais

public/
├── index.html                # HTML principal
└── dist/
    └── bundle.js            # Bundle gerado pelo esbuild
```

### Stack Tecnológica

- **Frontend**: React 18 + TypeScript
- **Build**: esbuild (super rápido!)
- **Styling**: CSS puro (sem dependências extras)
- **State Management**: useState hooks (sem Redux)
- **API Communication**: Fetch API nativa

## 🔧 Scripts Disponíveis

```bash
# Build do frontend (produção)
npm run build:frontend

# Build do frontend com watch mode (desenvolvimento)
npm run build:frontend:watch

# Iniciar backend + frontend
# Terminal 1:
npm run dev

# Terminal 2 (opcional, para hot reload do frontend):
npm run build:frontend:watch
```

## 📡 API Endpoints Utilizados

### Fluxos
- `GET /message-flows?instance={instance}` - Listar fluxos
- `GET /message-flows/:id` - Buscar fluxo específico
- `POST /message-flows` - Criar fluxo
- `PUT /message-flows/:id` - Atualizar fluxo
- `DELETE /message-flows/:id` - Deletar fluxo
- `POST /message-flows/:id/duplicate` - Duplicar fluxo

### Steps
- `GET /message-flows/:flowId/steps` - Listar steps do fluxo
- `GET /message-flows/steps/:stepId` - Buscar step específico
- `POST /message-flows/:flowId/steps` - Criar step
- `PUT /message-flows/steps/:stepId` - Atualizar step
- `DELETE /message-flows/steps/:stepId` - Deletar step
- `PUT /message-flows/:flowId/reorder` - Reordenar steps

### Utilitários
- `GET /message-flows/meta/step-types` - Tipos de steps disponíveis
- `POST /message-flows/:flowId/validate` - Validar fluxo

## 🎨 Guia de Interface

### Cores e Ícones

- **Primária**: #667eea (roxo) - Ações principais
- **Sucesso**: #28a745 (verde) - Steps ativos
- **Aviso**: #ffc107 (amarelo) - Steps desabilitados
- **Perigo**: #dc3545 (vermelho) - Deletar
- **→**: Conexão para próximo step
- **⤴**: Conexão para fallback step
- **✏️**: Editar
- **🗑️**: Deletar
- **📋**: Duplicar
- **⏸️**: Desabilitar
- **▶️**: Habilitar

### Responsividade

A interface é totalmente responsiva e funciona em:
- 🖥️ Desktop (1400px+)
- 💻 Laptop (1024px)
- 📱 Tablet (768px)
- 📱 Mobile (320px+)

## 🐛 Troubleshooting

### Frontend não carrega

1. Verifique se o build foi feito:
   ```bash
   npm run build:frontend
   ```

2. Verifique se o arquivo existe:
   ```bash
   ls public/dist/bundle.js
   ```

3. Verifique o console do navegador (F12)

### API não responde

1. Verifique se o backend está rodando:
   ```bash
   npm run dev
   ```

2. Verifique a porta no `.env`:
   ```
   LISTEN_PORT=8005
   ```

3. Acesse diretamente a API:
   ```
   http://localhost:8005/message-flows?instance=vollo
   ```

### Erros de TypeScript

1. Limpe e reinstale dependências:
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

2. Refaça o build:
   ```bash
   npm run build:frontend
   ```

## 📚 Próximos Passos

Possíveis melhorias futuras:

1. **Drag & Drop**: Arrastar e soltar steps para reordenar
2. **Importar/Exportar**: Exportar fluxo como JSON e importar
3. **Templates**: Biblioteca de fluxos pré-configurados
4. **Validação em Tempo Real**: Validar configuração enquanto digita
5. **Histórico**: Ver histórico de alterações do fluxo
6. **Permissões**: Controle de acesso por usuário
7. **Testes**: Simular execução do fluxo com dados de teste
8. **Estatísticas**: Dashboard com métricas de uso dos fluxos

## 🎓 Referências

- [Documentação dos Steps](./STEPS_DOCUMENTATION.md)
- [Manual de Criação de Fluxos (SQL)](./MANUAL_CRIACAO_FLUXOS.md)
- [Correção da Factory](../refactor/CORRECAO_FACTORY.md)
- [Nomenclatura dos Steps](../refactor/NOMENCLATURA_STEPS.md)

---

**Desenvolvido com ❤️ para facilitar o gerenciamento de fluxos do WhatsApp Service**
