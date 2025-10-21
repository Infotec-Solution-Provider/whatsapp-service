# 🌐 Sistema de Fluxos de Mensagens - Documentação Completa

## ⚡ Acesso Rápido

**Interface Web**: `http://localhost:8005/flows` ✨ **RECOMENDADO!**

## 🎯 Visão Geral

Sistema completo de fluxos de mensagens baseado em **Chain of Responsibility Pattern** com interface web moderna e API REST completa. Crie, edite e gerencie fluxos visualmente sem precisar escrever SQL!

---

## 📖 Documentação Disponível

### 🌐 Interface Web (NOVO!)

**[WEB_INTERFACE.md](./WEB_INTERFACE.md)** - Guia completo da interface visual
- ✨ Crie e edite fluxos visualmente
- 🎨 Visualize o fluxo em formato de árvore
- 🔍 Busque e filtre fluxos facilmente
- ✓ Valide fluxos automaticamente
- 📋 Duplique fluxos entre instâncias
- **Sem necessidade de escrever SQL!**

### 🚀 Para Começar (Usuários)

1. **[Manual de Criação de Fluxos](./MANUAL_CRIACAO_FLUXOS.md)**
   - Como funciona o sistema
   - Estrutura do banco de dados
   - Passo a passo para criar fluxos (via SQL)
   - Templates SQL prontos
   - Consultas úteis

2. **[Documentação Completa dos Steps](./STEPS_DOCUMENTATION.md)**
   - Todos os steps disponíveis
   - Configurações detalhadas
   - Exemplos práticos
   - Troubleshooting

3. **[Exemplos Práticos de Fluxos](./EXEMPLOS_PRATICOS_FLUXOS.md)**
   - Fluxo básico de distribuição
   - Fluxo com priorização VIP
   - Fluxo por horário
   - Fluxo por tipo de cliente
   - Fluxo com fidelização

### 🔧 Documentação Técnica (Desenvolvedores)

4. **[Nomenclatura de Steps](../refactor/NOMENCLATURA_STEPS.md)**
   - Padronização de nomes
   - stepNumber vs stepId
   - Estrutura do código

5. **[Correção do Factory](../refactor/CORRECAO_FACTORY.md)**
   - Problema com next_step_id
   - Solução implementada
   - Fluxos não-lineares

---

## 🚀 Quick Start

### Método 1: Interface Web (Recomendado) ✨

```bash
# 1. Inicie o servidor
npm run dev

# 2. Abra no navegador
# http://localhost:8005/flows

# 3. Crie seu fluxo visualmente!
```

### Método 2: API REST

```bash
# Listar fluxos
curl http://localhost:8005/message-flows?instance=vollo

# Criar fluxo
curl -X POST http://localhost:8005/message-flows \
  -H "Content-Type: application/json" \
  -d '{"instance": "vollo", "description": "Meu Fluxo"}'

# Criar step
curl -X POST http://localhost:8005/message-flows/1/steps \
  -H "Content-Type: application/json" \
  -d '{
    "stepNumber": 1,
    "stepType": "QUERY",
    "nextStepId": 2,
    "config": {"text": "Olá!"}
  }'
```

### Método 3: SQL Direto

```sql
-- Criar fluxo
INSERT INTO message_flows (instance, description)
VALUES ('vollo', 'Fluxo de Atendimento');

-- Criar step
INSERT INTO message_flows_steps (
  flow_id, step_number, step_type, next_step_id, config
) VALUES (
  1, 1, 'QUERY', 2, '{"text": "Olá! Como posso ajudar?"}'
);
```

---

## 🎨 Funcionalidades da Interface Web

### 📋 Lista de Fluxos
- Visualização em cards com informações resumidas
- Busca por descrição, ID ou setor
- Filtros por instância
- Ações rápidas: editar, deletar, duplicar, habilitar/desabilitar

### ✏️ Editor de Fluxos
- Visualização em lista ou modo visual (árvore)
- Adicionar, editar e remover steps
- Reordenação de steps
- Validação de integridade do fluxo
- Edição inline de descrição

### 🎯 Editor de Steps
- Formulário completo com todos os campos
- Editor de JSON com syntax highlighting
- Seleção visual de next_step_id e fallback_step_id
- Exemplos de configuração por tipo de step
- Validação em tempo real

### 🌳 Visualização Visual
- Representação em árvore do fluxo
- Indicação de conexões (next → e fallback ⤴)
- Cores diferentes para steps habilitados/desabilitados
- Preview da configuração de cada step

---

## 📡 API REST Endpoints

### Fluxos
- `GET /message-flows?instance={instance}` - Listar fluxos
- `GET /message-flows/:id` - Buscar fluxo específico
- `POST /message-flows` - Criar fluxo
- `PUT /message-flows/:id` - Atualizar fluxo
- `DELETE /message-flows/:id` - Deletar fluxo
- `POST /message-flows/:id/duplicate` - Duplicar fluxo

### Steps
- `GET /message-flows/:flowId/steps` - Listar steps
- `GET /message-flows/steps/:stepId` - Buscar step
- `POST /message-flows/:flowId/steps` - Criar step
- `PUT /message-flows/steps/:stepId` - Atualizar step
- `DELETE /message-flows/steps/:stepId` - Deletar step
- `PUT /message-flows/:flowId/reorder` - Reordenar steps

### Utilitários
- `GET /message-flows/meta/step-types` - Tipos de steps disponíveis
- `POST /message-flows/:flowId/validate` - Validar fluxo

---

## 🔍 Tipos de Steps Disponíveis

### Steps Genéricos
- **QUERY**: Envia uma mensagem
- **CONDITION**: Avalia uma condição
- **ROUTER**: Roteia baseado em opções do usuário
- **ASSIGN**: Atribui chat a um agente/setor

### Steps Específicos
- **CHECK_ONLY_ADMIN**: Verifica se apenas admin pode atender
- **CHECK_LOALTY**: Verifica programa de fidelidade
- **CHECK_AVAILABLE_USERS**: Verifica disponibilidade de usuários
- **SEND_TO_ADMIN**: Envia para admin
- **SELLER_MENU**: Menu de vendedor
- **CHOOSE_SELLER**: Escolher vendedor específico
- **CHOOSE_SECTOR**: Escolher setor
- **CHOOSE_AGENT**: Escolher agente
- **SATISFACTION**: Pesquisa de satisfação

---

## 💡 Melhores Práticas

1. ✨ **Use a interface web** - Muito mais prático e intuitivo
2. 📝 **Descreva seus fluxos e steps** - Facilita manutenção futura
3. 🔢 **Numere sequencialmente** - Facilita visualização e ordenação
4. ✓ **Valide sempre** - Use o botão "Validar Fluxo" antes de ativar
5. 🌳 **Use o modo visual** - Entenda o fluxo graficamente
6. 🧪 **Teste em desenvolvimento** - Crie um fluxo de teste primeiro
7. 📋 **Duplique fluxos** - Reutilize estruturas que funcionam
8. 💾 **Faça backup** - Exporte configurações importantes

---

## 🐛 Troubleshooting

### Interface web não carrega
```bash
# Verificar se o build existe
ls public/dist/bundle.js

# Refazer build
npm run build:frontend

# Verificar servidor
npm run dev
```

### Fluxo não executa
- ✅ Fluxo está habilitado?
- ✅ Steps estão habilitados?
- ✅ next_step_id aponta para steps válidos?
- ✅ Validação do fluxo passou?
- 📋 Use o botão "✓ Validar Fluxo" na interface

### Erro de configuração
- 📝 JSON está válido?
- 📋 Campos obrigatórios preenchidos?
- 📖 Confira a [documentação do step](./STEPS_DOCUMENTATION.md)
- 💡 Use os exemplos da interface

---

## 🛠️ Stack Tecnológica

### Backend
- **Framework**: Express.js + TypeScript
- **ORM**: Prisma
- **Database**: PostgreSQL
- **Pattern**: Chain of Responsibility

### Frontend
- **Framework**: React 18 + TypeScript
- **Build**: esbuild
- **Styling**: CSS puro
- **State**: React Hooks (useState)
- **API**: Fetch API nativa

---

## 📦 Scripts NPM

```bash
# Backend
npm run dev                  # Iniciar servidor backend
npm start                    # Produção

# Frontend
npm run build:frontend       # Build produção
npm run build:frontend:watch # Build com hot reload

# Desenvolvimento completo
# Terminal 1:
npm run dev

# Terminal 2 (opcional, hot reload do frontend):
npm run build:frontend:watch
```

---

## 🔗 Links Úteis

- [Interface Web - Guia Completo](./WEB_INTERFACE.md)
- [Manual SQL de Criação](./MANUAL_CRIACAO_FLUXOS.md)
- [Documentação dos Steps](./STEPS_DOCUMENTATION.md)
- [Exemplos Práticos](./EXEMPLOS_PRATICOS_FLUXOS.md)
- [Refatoração e Correções](../refactor/)

---

**Desenvolvido com ❤️ para facilitar o gerenciamento de fluxos do WhatsApp Service**

**Última atualização**: Janeiro 2025
