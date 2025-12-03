# Parâmetros de Configuração - Comportamento Humano

## 📋 Visão Geral

O sistema de comportamento humano pode ser totalmente configurado via parâmetros de instância no banco de dados. Isso permite personalizar ou desabilitar completamente a simulação de comportamento humano sem alterar código.

## 🎛️ Parâmetros Disponíveis

### Ativação Geral

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `human_behavior.enabled` | boolean | `true` | Ativa/desativa toda a simulação de comportamento humano |

### Velocidade de Leitura

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `human_behavior.reading_speed.min` | number | `200` | Velocidade mínima de leitura (palavras/minuto) |
| `human_behavior.reading_speed.max` | number | `250` | Velocidade máxima de leitura (palavras/minuto) |

**Impacto:** Define quanto tempo o bot "espera" antes de processar uma mensagem recebida, simulando leitura.

### Tempo de Pensamento

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `human_behavior.thinking_time.min` | number | `2000` | Tempo mínimo de pensamento em ms |
| `human_behavior.thinking_time.max` | number | `8000` | Tempo máximo de pensamento em ms |

**Impacto:** Delay antes de começar a "digitar" a resposta, simulando o tempo que uma pessoa leva para pensar na resposta.

### Velocidade de Digitação

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `human_behavior.typing_speed.min` | number | `40` | Velocidade mínima de digitação (palavras/minuto) |
| `human_behavior.typing_speed.max` | number | `60` | Velocidade máxima de digitação (palavras/minuto) |

**Impacto:** Define quanto tempo o bot aguarda antes de enviar a mensagem, proporcional ao tamanho do texto.

### Estado de Digitação

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `human_behavior.send_typing_state` | boolean | `true` | Envia estado "digitando..." para o destinatário |
| `human_behavior.typing_state_duration.min` | number | `1000` | Duração mínima do estado "digitando..." em ms |
| `human_behavior.typing_state_duration.max` | number | `3000` | Duração máxima do estado "digitando..." em ms |

**Impacto:** Mostra o indicador de "digitando..." para o destinatário antes de enviar a mensagem.

## 📝 Inserindo Parâmetros no Banco

### SQL - Configuração Padrão

```sql
-- Ativar comportamento humano
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.enabled', 'true')
ON DUPLICATE KEY UPDATE value = 'true';

-- Velocidade de leitura (200-250 palavras/min)
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.reading_speed.min', '200')
ON DUPLICATE KEY UPDATE value = '200';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.reading_speed.max', '250')
ON DUPLICATE KEY UPDATE value = '250';

-- Tempo de pensamento (2-8 segundos)
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.thinking_time.min', '2000')
ON DUPLICATE KEY UPDATE value = '2000';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.thinking_time.max', '8000')
ON DUPLICATE KEY UPDATE value = '8000';

-- Velocidade de digitação (40-60 palavras/min)
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.typing_speed.min', '40')
ON DUPLICATE KEY UPDATE value = '40';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.typing_speed.max', '60')
ON DUPLICATE KEY UPDATE value = '60';

-- Estado de digitação
INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.send_typing_state', 'true')
ON DUPLICATE KEY UPDATE value = 'true';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.typing_state_duration.min', '1000')
ON DUPLICATE KEY UPDATE value = '1000';

INSERT INTO parameters (scope, instance, sector_id, user_id, `key`, value)
VALUES ('INSTANCE', 'sua-instancia', NULL, NULL, 'human_behavior.typing_state_duration.max', '3000')
ON DUPLICATE KEY UPDATE value = '3000';
```

### TypeScript - Criar Parâmetros Programaticamente

```typescript
import humanBehaviorConfigService from './services/human-behavior-config.service';

// Cria todos os parâmetros padrão para uma instância
await humanBehaviorConfigService.createDefaultParameters('sua-instancia');
```

## 🎯 Exemplos de Uso

### Desabilitar Completamente

```sql
UPDATE parameters 
SET value = 'false' 
WHERE `key` = 'human_behavior.enabled' 
AND instance = 'sua-instancia';
```

Após alterar, reinicie o cliente ou invalide o cache:
```typescript
humanBehaviorConfigService.invalidateCache('sua-instancia');
```

### Respostas Mais Rápidas (Modo Urgente)

```sql
-- Reduzir tempo de pensamento para 0.5-2 segundos
UPDATE parameters SET value = '500' 
WHERE `key` = 'human_behavior.thinking_time.min' AND instance = 'sua-instancia';

UPDATE parameters SET value = '2000' 
WHERE `key` = 'human_behavior.thinking_time.max' AND instance = 'sua-instancia';

-- Aumentar velocidade de digitação para 80-100 palavras/min
UPDATE parameters SET value = '80' 
WHERE `key` = 'human_behavior.typing_speed.min' AND instance = 'sua-instancia';

UPDATE parameters SET value = '100' 
WHERE `key` = 'human_behavior.typing_speed.max' AND instance = 'sua-instancia';
```

### Respostas Mais Naturais/Lentas

```sql
-- Aumentar tempo de pensamento para 5-15 segundos
UPDATE parameters SET value = '5000' 
WHERE `key` = 'human_behavior.thinking_time.min' AND instance = 'sua-instancia';

UPDATE parameters SET value = '15000' 
WHERE `key` = 'human_behavior.thinking_time.max' AND instance = 'sua-instancia';

-- Reduzir velocidade de digitação para 30-45 palavras/min
UPDATE parameters SET value = '30' 
WHERE `key` = 'human_behavior.typing_speed.min' AND instance = 'sua-instancia';

UPDATE parameters SET value = '45' 
WHERE `key` = 'human_behavior.typing_speed.max' AND instance = 'sua-instancia';
```

### Desabilitar Apenas o Estado "Digitando..."

```sql
UPDATE parameters 
SET value = 'false' 
WHERE `key` = 'human_behavior.send_typing_state' 
AND instance = 'sua-instancia';
```

## 🔄 Recarregar Configuração

A configuração é carregada automaticamente quando o cliente é iniciado. Para recarregar sem reiniciar:

```typescript
// Invalida cache e força recarregamento
humanBehaviorConfigService.invalidateCache('sua-instancia');

// Na próxima mensagem, a configuração será recarregada automaticamente
```

## 📊 Monitoramento

### Verificar Configuração Atual

```typescript
const config = await humanBehaviorConfigService.getConfig('sua-instancia');
console.log(config);
```

### Logs

Quando o cliente inicia, você verá nos logs:

```
[sua-instancia:123] Comportamento humano: ATIVADO
```

ou

```
[sua-instancia:123] Comportamento humano: DESATIVADO
```

Durante o envio de mensagens (se enabled = true):

```
[sua-instancia] Simulando comportamento humano...
[sua-instancia] Simulando leitura: 3s
[sua-instancia] Simulando pensamento: 5s
[sua-instancia] Simulando digitação: 4s
[sua-instancia] Enviando estado de digitação...
[sua-instancia] Enviando mensagem...
```

## ⚙️ Validações

O sistema valida automaticamente:

✅ `min` não pode ser maior que `max`  
✅ Valores não podem ser negativos  
✅ Valores inválidos usam o padrão  

Se houver erro na validação, o sistema usa a configuração padrão e loga o erro.

## 🎓 Recomendações

### Para Evitar Banimentos
- ✅ Mantenha `enabled = true`
- ✅ Use valores realistas (40-60 palavras/min para digitação)
- ✅ Mantenha `send_typing_state = true`

### Para Performance
- ⚠️ Desabilitar pode acelerar, mas aumenta risco de banimento
- ⚠️ Valores muito baixos podem causar delays excessivos
- ✅ Ajuste conforme o volume de mensagens

### Para Testar/Desenvolvimento
- 🔧 Use `enabled = false` em ambiente de desenvolvimento
- 🔧 Ou reduza drasticamente os tempos para testes rápidos

## 🚨 Troubleshooting

### Configuração não está sendo aplicada

1. Verifique se os parâmetros estão no banco:
```sql
SELECT * FROM parameters 
WHERE instance = 'sua-instancia' 
AND `key` LIKE 'human_behavior%';
```

2. Invalide o cache:
```typescript
humanBehaviorConfigService.invalidateCache('sua-instancia');
```

3. Reinicie o cliente WhatsApp

### Mensagens muito lentas

Reduza os tempos mínimos e máximos:
```sql
UPDATE parameters SET value = '1000' 
WHERE `key` = 'human_behavior.thinking_time.min';

UPDATE parameters SET value = '3000' 
WHERE `key` = 'human_behavior.thinking_time.max';
```

### Estado "digitando..." não aparece

Verifique:
```sql
SELECT value FROM parameters 
WHERE `key` = 'human_behavior.send_typing_state' 
AND instance = 'sua-instancia';
```

Deve retornar `'true'` (string).

## 📚 Referências

- **Serviço de Configuração**: `src/services/human-behavior-config.service.ts`
- **Simulador**: `src/utils/human-behavior.simulator.ts`
- **Cliente WhatsApp**: `src/whatsapp-client/wwebjs-whatsapp-client.ts`
- **Serviço de Parâmetros**: `src/services/parameters.service.ts`
