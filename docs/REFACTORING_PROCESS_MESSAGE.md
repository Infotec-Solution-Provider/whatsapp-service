# Refatoração do processMessage - Melhorias Implementadas

## 🎯 Objetivo

Tornar o método `processMessage` mais flexível, manutenível e extensível, eliminando código "engessado" e seguindo princípios SOLID.

## ✨ Principais Melhorias

### 1. **Registry Pattern para Bots**

#### ❌ Antes (Switch/Case engessado)
```typescript
switch(currChat.botId) {
    case 1:
        if (currChat.instance === "vollo") {
            await chooseSellerBot.processMessage(currChat, contact, msg);
        } else {
            await chooseSectorBot.processMessage(currChat, contact, msg);
        }
        break;
    case 2:
        await exatronSatisfactionBot.processMessage(currChat, contact, msg);
        break;
    case 3:
        await customerLinkingBot.processMessage(currChat, contact, msg);
        break;
}
```

#### ✅ Depois (Registry dinâmico)
```typescript
// Interface padronizada
interface BotProcessor {
    processMessage(chat: WppChat, contact: WppContact, message: WppMessage): Promise<void>;
    startBot?(chat: WppChat, contact: WppContact, to: string, quotedId?: number): Promise<void>;
    shouldActivate?(chat: WppChat, contact: WppContact): Promise<boolean>;
}

// Registry centralizado
private botRegistry: BotRegistry = new Map();

private registerBots() {
    this.botRegistry.set(1, chooseSectorBot);
    this.botRegistry.set(2, exatronSatisfactionBot);
    this.botRegistry.set(3, customerLinkingBot);
    // Adicionar novos bots: this.botRegistry.set(4, newBot);
}

// Uso
const bot = this.botRegistry.get(chat.botId);
if (bot) {
    await bot.processMessage(chat, contact, msg);
}
```

**Vantagens:**
- ✅ Adicionar novo bot: apenas 1 linha
- ✅ Sem modificar lógica principal
- ✅ Fácil de testar e mockar
- ✅ Sem switch/case gigantes

---

### 2. **Separação de Responsabilidades**

#### Métodos Extraídos:

##### `processBotMessage()` - Processa bot em chat existente
```typescript
private async processBotMessage(
    chat: WppChat, 
    contact: WppContact, 
    msg: WppMessage, 
    logger: ProcessingLogger
)
```
- Responsável apenas por processar mensagens em chats com bot ativo
- Usa o registry para buscar o bot correto
- Trata exceção do Vollo de forma isolada

##### `initializeBotForNewChat()` - Inicializa bot em novo chat
```typescript
private async initializeBotForNewChat(
    chat: WppChat, 
    contact: WppContact, 
    msg: WppMessage, 
    logger: ProcessingLogger
)
```
- Responsável por iniciar bots em chats novos
- Usa `startBot()` se disponível, senão `processMessage()`
- Tratamento especial para Vollo isolado

##### `determineBotForNewChat()` - Determina qual bot ativar
```typescript
private async determineBotForNewChat(
    chat: WppChat,
    contact: WppContact,
    logger: ProcessingLogger
): Promise<number | null>
```
- Verifica todos os bots registrados
- Usa método `shouldActivate()` quando disponível
- Retorna ID do bot ou null
- Extensível: novos bots com `shouldActivate()` são verificados automaticamente

##### `createNewChat()` - Cria novo chat
```typescript
private async createNewChat(
    instance: string,
    sectors: WppSector[],
    contact: WppContact,
    logger: ProcessingLogger
): Promise<{ chat: WppChat; systemMessage: string | null }>
```
- Lógica de criação de chat isolada
- Retorna chat e mensagem de sistema
- Ativa bots dinamicamente via `determineBotForNewChat()`

---

### 3. **Método processMessage Simplificado**

#### ❌ Antes (200+ linhas, múltiplas responsabilidades)
```typescript
public async processMessage(...) {
    // Busca contato
    // Busca chat
    // If chat existe
        // Switch case para bots
    // Else
        // If múltiplos setores
            // Cria chat tipo 1
        // Else if vollo
            // Cria chat tipo 2
        // Else
            // Cria chat tipo 3
            // Verifica bot de vinculação
        // If botId === 1
            // Inicializa bot 1
        // If botId === 3
            // Inicializa bot 3
    // Busca avatar
    // Etc...
}
```

#### ✅ Depois (Claro e legível)
```typescript
public async processMessage(...) {
    try {
        // 1. Busca ou cria contato
        const contact = await contactsService.getOrCreateContact(...);

        // 2. Busca chat existente
        const currChat = await chatsService.getChatForContact(...);
        await this.checkAndSendAutoResponseMessage(...);

        // 3. Processa mensagem em chat existente
        if (currChat) {
            const outputMessage = await this.insertAndNotify(...);
            await this.processBotMessage(currChat, contact, msg, logger);
            return outputMessage;
        }

        // 4. Cria novo chat
        const sectors = await this.getSectors(clientId);
        const { chat: newChat, systemMessage } = await this.createNewChat(...);

        // 5. Inicializa bot se necessário
        await this.initializeBotForNewChat(...);

        // 6. Finaliza criação do chat
        // ... avatar, system message, etc
        
        return outputMsg;
    } catch (err) {
        // Error handling
    }
}
```

**Vantagens:**
- ✅ Código autoexplicativo
- ✅ Fácil de entender o fluxo
- ✅ Cada etapa bem definida
- ✅ Comentários numerados guiam a leitura

---

## 🚀 Como Adicionar Novo Bot

### Antes (múltiplas alterações)
```typescript
// 1. Importar bot
import newBot from "../bots/new.bot";

// 2. Adicionar no switch do chat existente
switch(currChat.botId) {
    // ... casos existentes
    case 4:
        await newBot.processMessage(currChat, contact, msg);
        break;
}

// 3. Adicionar lógica de ativação
const shouldActivateNewBot = await newBot.shouldActivate(newChat, contact);
if (shouldActivateNewBot) {
    newChat = await prismaService.wppChat.update({
        where: { id: newChat.id },
        data: { botId: 4 }
    });
}

// 4. Adicionar inicialização
if (newChat.botId === 4) {
    await newBot.startBot(newChat, contact, msg.from, msg.id);
}
```

### Depois (1 linha!)
```typescript
// 1. Importar bot
import newBot from "../bots/new.bot";

// 2. Registrar (no método registerBots)
this.botRegistry.set(4, newBot);

// PRONTO! 🎉
// O resto funciona automaticamente via registry
```

---

## 📊 Comparação de Complexidade

| Aspecto | Antes | Depois |
|---------|-------|--------|
| **Linhas do processMessage** | ~120 | ~40 |
| **Métodos auxiliares** | 0 | 4 |
| **Para adicionar bot** | ~15 linhas | 1 linha |
| **Complexidade ciclomática** | Alta | Baixa |
| **Testabilidade** | Difícil | Fácil |
| **Manutenibilidade** | Baixa | Alta |

---

## 🧪 Testabilidade

### Antes
```typescript
// Difícil testar: precisa mockar todo o fluxo
```

### Depois
```typescript
// Fácil testar cada método isoladamente
describe('processBotMessage', () => {
    it('should process bot 3', async () => {
        const mockBot = { processMessage: jest.fn() };
        service['botRegistry'].set(3, mockBot);
        
        await service['processBotMessage'](chat, contact, msg, logger);
        
        expect(mockBot.processMessage).toHaveBeenCalled();
    });
});

describe('determineBotForNewChat', () => {
    it('should activate bot with shouldActivate', async () => {
        const mockBot = { 
            shouldActivate: jest.fn().mockResolvedValue(true),
            processMessage: jest.fn()
        };
        service['botRegistry'].set(5, mockBot);
        
        const botId = await service['determineBotForNewChat'](chat, contact, logger);
        
        expect(botId).toBe(5);
    });
});
```

---

## 🎯 Princípios SOLID Aplicados

### ✅ Single Responsibility Principle (SRP)
- Cada método tem UMA responsabilidade clara
- `processBotMessage`: apenas processa bots em chats existentes
- `initializeBotForNewChat`: apenas inicializa bots em novos chats
- `determineBotForNewChat`: apenas determina qual bot ativar
- `createNewChat`: apenas cria chats

### ✅ Open/Closed Principle (OCP)
- Aberto para extensão (adicionar novos bots)
- Fechado para modificação (não precisa alterar lógica)
- Registry permite adicionar bots sem tocar no código core

### ✅ Liskov Substitution Principle (LSP)
- Interface `BotProcessor` garante contrato
- Todos os bots são intercambiáveis
- Métodos opcionais (`?`) para flexibilidade

### ✅ Interface Segregation Principle (ISP)
- Interface `BotProcessor` com métodos opcionais
- Bots implementam apenas o necessário
- `shouldActivate?` e `startBot?` são opcionais

### ✅ Dependency Inversion Principle (DIP)
- Código depende de abstrações (`BotProcessor`)
- Não depende de implementações concretas
- Registry injeta dependências

---

## 🔧 Extensibilidade

### Exemplo: Adicionar Sistema de Prioridade de Bots

```typescript
interface BotProcessor {
    processMessage(...): Promise<void>;
    startBot?(...): Promise<void>;
    shouldActivate?(...): Promise<boolean>;
    priority?: number; // Nova propriedade
}

private async determineBotForNewChat(...) {
    const candidates: Array<{ botId: number; priority: number }> = [];
    
    for (const [botId, bot] of this.botRegistry.entries()) {
        if (bot.shouldActivate) {
            const shouldActivate = await bot.shouldActivate(chat, contact);
            if (shouldActivate) {
                candidates.push({ 
                    botId, 
                    priority: bot.priority ?? 999 
                });
            }
        }
    }
    
    // Retorna o bot com maior prioridade (menor número)
    if (candidates.length > 0) {
        candidates.sort((a, b) => a.priority - b.priority);
        return candidates[0]!.botId;
    }
    
    return null;
}
```

---

## 📈 Benefícios Imediatos

1. **Manutenção Simplificada**: Código mais fácil de entender e modificar
2. **Adicionar Bots**: De ~15 linhas para 1 linha
3. **Testes**: Cada método pode ser testado isoladamente
4. **Debug**: Mais fácil identificar onde ocorrem problemas
5. **Escalabilidade**: Sistema preparado para crescer
6. **Refatoração**: Mudanças isoladas não quebram todo o sistema
7. **Code Review**: Código mais claro facilita revisões
8. **Onboarding**: Novos devs entendem mais rápido

---

## 🎓 Lições Aprendidas

### ✅ Do's
- Extrair métodos com responsabilidades únicas
- Usar registry/map para lógica dinâmica
- Criar interfaces para padronizar contratos
- Comentar etapas principais do fluxo
- Retornar objetos estruturados (`{ chat, systemMessage }`)

### ❌ Don'ts
- Switch/case com muitos casos
- Métodos com múltiplas responsabilidades
- Lógica duplicada em vários lugares
- Hardcoded checks para cada bot
- Métodos gigantes (200+ linhas)

---

## 🚀 Próximos Passos Sugeridos

1. **Strategy Pattern para Criação de Chat**: Extrair lógicas específicas (Vollo, múltiplos setores) para strategies
2. **Event System**: Emitir eventos em vez de chamar métodos diretamente
3. **Middleware Chain**: Processar mensagens através de middlewares
4. **Bot Configuration**: Mover configurações para arquivo/banco
5. **Metrics**: Adicionar telemetria por bot
6. **Circuit Breaker**: Proteger contra bots problemáticos

---

## 📝 Resumo

A refatoração transformou um método monolítico de 120+ linhas com múltiplas responsabilidades em:

- **1 método principal** claro e objetivo (40 linhas)
- **4 métodos auxiliares** com responsabilidades únicas
- **Registry pattern** para gerenciar bots dinamicamente
- **Interface padronizada** para todos os bots
- **Extensibilidade** sem modificar código existente

**Resultado**: Código mais **limpo**, **testável**, **manutenível** e **escalável**! 🎉
