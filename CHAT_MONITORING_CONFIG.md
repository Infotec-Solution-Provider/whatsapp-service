# Parâmetros Configuráveis para Monitoramento de Chats

A nova implementação do `finishChatRoutine` agora suporta configuração flexível através do sistema de parâmetros. Os valores podem ser definidos por instância, setor ou usuário.

## Parâmetros Disponíveis

### CHAT_INACTIVITY_MS
- **Descrição**: Tempo limite para considerar o chat inativo (em milissegundos)
- **Padrão**: 1800000 (30 minutos)
- **Uso**: Após este tempo sem atividade, o sistema tomará ações apropriadas baseadas no contexto (enviar menu ou notificar)

### CHAT_MENU_RESPONSE_MS
- **Descrição**: Tempo limite para resposta ao menu de opções (em milissegundos)
- **Padrão**: 900000 (15 minutos)
- **Uso**: Após enviar o menu, se não houver resposta neste tempo, o chat será finalizado automaticamente

## Como Configurar

Os parâmetros devem ser inseridos na tabela `parameters` do banco de dados:

```sql
-- Exemplo: Configurar timeout de inatividade para 20 minutos na instância "nunes"
INSERT INTO parameters (instance, scope, key, value) 
VALUES ('nunes', 'INSTANCE', 'CHAT_INACTIVITY_MS', '1200000');

-- Exemplo: Configurar timeout de menu para 10 minutos no setor 5
INSERT INTO parameters (instance, scope, sectorId, key, value) 
VALUES ('nunes', 'SECTOR', 5, 'CHAT_MENU_RESPONSE_MS', '600000');

-- Exemplo: Configurar timeout de inatividade para usuário específico
INSERT INTO parameters (instance, scope, userId, key, value) 
VALUES ('nunes', 'USER', 123, 'CHAT_INACTIVITY_MS', '900000');
```

## Prioridade dos Parâmetros

Os parâmetros seguem a ordem de prioridade:
1. **Usuário** (maior prioridade)
2. **Setor**
3. **Instância**
4. **Padrão** (menor prioridade)

## Benefícios da Nova Implementação

- ✅ **Configurabilidade**: Timeouts ajustáveis por instância/setor/usuário
- ✅ **Flexibilidade**: Remove hardcoding da instância "nunes"
- ✅ **Logging Estruturado**: Melhor rastreabilidade com ProcessingLogger
- ✅ **Manutenibilidade**: Código organizado em funções menores e especializadas
- ✅ **Compatibilidade**: Mantém o comportamento existente com configuração padrão
- ✅ **Gerenciamento de Estado**: Sessões persistidas para recuperação após reinicialização