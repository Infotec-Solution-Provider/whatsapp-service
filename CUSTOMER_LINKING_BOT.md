# Bot de Vinculação de Cliente por CNPJ

## Descrição

Bot automático que identifica contatos sem cliente vinculado e realiza a vinculação através do CNPJ informado pelo usuário.

## Fluxo do Bot

### 1. Verificação Inicial
- O bot **não é disparado** se o contato já possui cliente vinculado (`customerId` preenchido)
- O bot só é ativado se estiver habilitado nos parâmetros

### 2. Solicitação de CNPJ
Quando ativado, o bot:
1. Solicita o CNPJ ao cliente
2. Valida o formato (14 dígitos numéricos)
3. Rejeita CNPJs inválidos ou com todos os dígitos iguais

### 3. Busca do Cliente
- Busca na tabela `clientes` da instância pelo campo `CPF_CNPJ`
- **Se encontrado:** Vincula o cliente ao contato e finaliza o bot
- **Se não encontrado:** Direciona para atendimento humano

### 4. Timeout de Inatividade
- Padrão: 10 minutos
- Após timeout: Direciona para atendimento humano
- Configurável por parâmetro

## Configuração

### Parâmetros Necessários

Para ativar o bot, configure os seguintes parâmetros no banco de dados:

#### 1. Habilitar o Bot
```sql
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'nome_da_instancia', NULL, NULL, 'customer_linking_bot_enabled', 'true');
```

**Escopos disponíveis:**
- `INSTANCE`: Aplica para toda a instância
- `SECTOR`: Aplica para um setor específico
- `USER`: Aplica para um usuário específico

#### 2. Timeout Personalizado (Opcional)
```sql
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('INSTANCE', 'nome_da_instancia', NULL, NULL, 'customer_linking_timeout_ms', '600000');
```
*Valor em milissegundos (600000 = 10 minutos)*

### Exemplos de Configuração

#### Ativar para uma instância específica
```sql
INSERT INTO parameters (scope, instance, `key`, `value`)
VALUES ('INSTANCE', 'exatron', 'customer_linking_bot_enabled', 'true');
```

#### Ativar para um setor específico
```sql
INSERT INTO parameters (scope, instance, sectorId, `key`, `value`)
VALUES ('SECTOR', 'exatron', 5, 'customer_linking_bot_enabled', 'true');
```

#### Configurar timeout de 5 minutos
```sql
INSERT INTO parameters (scope, instance, `key`, `value`)
VALUES ('INSTANCE', 'exatron', 'customer_linking_timeout_ms', '300000');
```

## Mensagens do Bot

### Mensagens Enviadas ao Cliente

- **Solicitação de CNPJ:** "Para prosseguir, preciso vincular seu cadastro. Por favor, informe o CNPJ da sua empresa."

- **CNPJ Inválido:** "CNPJ inválido. Por favor, digite um CNPJ válido (apenas números ou com formatação XX.XXX.XXX/XXXX-XX)."

- **Cliente Encontrado:** "Cliente encontrado! Vinculando seu cadastro..."

- **Vinculação Concluída:** "Cadastro vinculado com sucesso! Você já pode prosseguir com o atendimento."

- **Cliente Não Encontrado:** "Cliente não encontrado em nossa base de dados. Você será direcionado para atendimento humano."

- **Timeout:** "Atendimento finalizado por inatividade."

### Mensagens Internas (Sistema)

- **Início:** "Iniciando processo de vinculação de cliente."
- **Transferência:** "Cliente não vinculado. Direcionando para atendimento humano."

## Estrutura Técnica

### Bot ID
- **ID do Bot:** `3`
- Usado no campo `botId` da tabela `chats`

### Arquivo de Sessão
- **Arquivo:** `data/customer-linking.sessions.json`
- Armazena sessões ativas do bot
- Persistência automática

### Tabelas Utilizadas

#### Leitura
- `contacts`: Verifica se contato tem `customerId`
- `clientes` (instância): Busca cliente por `CPF_CNPJ`
- `parameters`: Configurações do bot

#### Escrita
- `contacts`: Atualiza `customerId` quando vincula
- `chats`: Atualiza `botId` para controle do fluxo
- `messages`: Mensagens do bot

## Integração

### Ativação Automática

O bot é ativado automaticamente quando:
1. Um novo chat é criado
2. O contato **não** possui cliente vinculado
3. O parâmetro `customer_linking_bot_enabled` está configurado como `true`

### Processamento de Mensagens

O bot processa mensagens quando `chat.botId === 3`:
```typescript
if (currChat.botId === 3) {
    await customerLinkingBot.processMessage(currChat, contact, msg);
}
```

## Exemplos de Uso no Código

### Verificar se contato tem cliente vinculado
```typescript
import customerLinkingBot from "../bots/customer-linking.bot";

const hasCustomer = await customerLinkingBot.hasCustomerLinked(contact);
if (!hasCustomer) {
    // Contato sem cliente
}
```

### Iniciar bot manualmente
```typescript
await customerLinkingBot.startBot(chat, contact, phone);
```

### Processar mensagem do cliente
```typescript
await customerLinkingBot.processMessage(chat, contact, message);
```

### Resetar sessão
```typescript
await customerLinkingBot.reset(chatId, contactId);
```

## Logs e Debugging

O bot utiliza `ProcessingLogger` para registrar todas as ações:

```
[customer-linking] Iniciando bot de vinculação de cliente
[customer-linking] Solicitando CNPJ ao cliente
[customer-linking] CNPJ válido recebido: 12345678000190
[customer-linking] Buscando cliente por CNPJ
[customer-linking] Cliente encontrado: 1234
[customer-linking] Vinculando cliente ao contato
[customer-linking] Cliente vinculado com sucesso
```

## Validações

### CNPJ
- Deve conter exatamente 14 dígitos numéricos
- Remove caracteres não numéricos automaticamente
- Rejeita CNPJs com todos os dígitos iguais (ex: 11111111111111)

### Contato
- Verifica se `customerId` é `null` ou `undefined`
- Só ativa o bot se não houver cliente vinculado

## Banco de Dados

### Estrutura da Query de Busca
```sql
SELECT CODIGO, NOME, CPF_CNPJ 
FROM clientes 
WHERE CPF_CNPJ = ? 
LIMIT 1
```

### Atualização do Contato
```typescript
await prismaService.wppContact.update({
    where: { id: contactId },
    data: { customerId }
});
```

## Troubleshooting

### Bot não está sendo ativado
1. Verificar se o parâmetro `customer_linking_bot_enabled` está configurado
2. Verificar se o contato realmente não tem `customerId`
3. Verificar logs para mensagens de erro

### Cliente não é encontrado
1. Verificar se o CNPJ existe na tabela `clientes`
2. Verificar formato do campo `CPF_CNPJ` no banco
3. Cliente será direcionado para atendimento humano

### Timeout muito curto/longo
1. Ajustar parâmetro `customer_linking_timeout_ms`
2. Valor em milissegundos
3. Padrão: 600000 (10 minutos)

## Manutenção

### Limpar sessões antigas
As sessões são limpas automaticamente quando:
- Chat é finalizado
- Timeout é atingido
- Bot completa o fluxo

### Monitorar arquivo de sessões
```bash
cat data/customer-linking.sessions.json
```

## Próximos Passos

Possíveis melhorias futuras:
- [ ] Busca por CPF além de CNPJ
- [ ] Múltiplas tentativas de busca
- [ ] Cadastro automático de novo cliente
- [ ] Validação matemática completa do CNPJ
- [ ] Suporte a múltiplos documentos
