# Configuração de Busca Local na Monitoria

## Visão Geral

A monitoria agora usa o sistema de parâmetros para decidir entre dois modos de busca:

- **Busca Padrão**: Carrega todos os dados e filtra em memória (modo anterior)
- **Busca Local**: Executa queries SQL otimizadas que filtram no banco de dados (mais rápido e eficiente)

## Como Funciona

O sistema verifica o parâmetro `monitor.useLocalSearch` seguindo a hierarquia:

1. Parâmetro de **USUÁRIO** (maior prioridade)
2. Parâmetro de **SETOR**
3. Parâmetro de **INSTÂNCIA** (menor prioridade)

Se o parâmetro estiver definido como `"true"`, usa a busca local. Caso contrário, usa a busca padrão.

## Ativando a Busca Local

### Método 1: Via SQL (Recomendado)

Use o script `scripts/configure-monitor-local-search.sql`:

```sql
-- Para uma instância específica
INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
VALUES ('INSTANCE', 'monitor.useLocalSearch', 'true', 'nunes', NULL, NULL)
ON DUPLICATE KEY UPDATE value = 'true';

-- Para um setor específico
INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
VALUES ('SECTOR', 'monitor.useLocalSearch', 'true', NULL, 1, NULL)
ON DUPLICATE KEY UPDATE value = 'true';

-- Para um usuário específico
INSERT INTO parameters (scope, `key`, value, instance, sectorId, userId)
VALUES ('USER', 'monitor.useLocalSearch', 'true', 'nunes', NULL, 1)
ON DUPLICATE KEY UPDATE value = 'true';
```

### Método 2: Via API (futuro)

Quando a interface de parâmetros estiver disponível, você poderá configurar diretamente pela UI.

## Desativando a Busca Local

Para voltar ao modo padrão, defina o parâmetro como `"false"`:

```sql
UPDATE parameters 
SET value = 'false'
WHERE `key` = 'monitor.useLocalSearch';
```

Ou simplesmente remova o parâmetro:

```sql
DELETE FROM parameters 
WHERE `key` = 'monitor.useLocalSearch';
```

## Diferenças entre os Modos

### Busca Padrão
- Carrega todos os chats e mensagens em memória
- Filtra os dados em JavaScript
- Mais lento para grandes volumes de dados
- Funciona em qualquer situação

### Busca Local
- Executa queries SQL otimizadas
- Filtra no banco de dados
- **Muito mais rápido** para grandes volumes
- Suporta busca por coluna específica (nome, telefone, cliente, mensagem)
- Requer índices apropriados no banco

## Campos de Busca Disponíveis (Busca Local)

A busca local permite selecionar o campo específico:

- **Todos os campos**: Busca em nome, telefone, cliente e mensagens
- **Nome**: Busca apenas no nome do contato
- **Telefone**: Busca apenas no telefone do contato
- **Cliente**: Busca na razão social e CPF/CNPJ do cliente
- **Mensagem**: Busca no conteúdo das mensagens

## Testando a Configuração

1. Ative o parâmetro para seu usuário/setor/instância
2. Acesse a monitoria
3. Faça uma busca e verifique a velocidade
4. Compare com o modo padrão desativando o parâmetro

## Troubleshooting

### A busca está lenta mesmo com busca local ativada

- Verifique se o parâmetro foi realmente configurado:
  ```sql
  SELECT * FROM parameters WHERE `key` = 'monitor.useLocalSearch';
  ```
- Certifique-se de que há índices apropriados nas tabelas:
  - `wpp_chats` (instance, contact_id, user_id, finished_at)
  - `wpp_contacts` (name, phone, customer_id)
  - `wpp_messages` (contact_id, body, sent_at)
  - `wpp_last_messages` (instance, contact_id)

### O parâmetro não está sendo aplicado

Verifique a hierarquia de prioridade:
- Um parâmetro de usuário sobrescreve setor e instância
- Um parâmetro de setor sobrescreve instância
- Certifique-se de que está editando o parâmetro correto

## Recomendações

- **Use busca local** para instâncias com muitos chats (>1000)
- **Use busca padrão** apenas se houver problemas com a busca local
- Configure por instância primeiro, depois ajuste por setor/usuário se necessário
