# Guia Rápido - Bot de Vinculação de Cliente

## 🚀 Início Rápido

### 1. Habilitar o Bot

Execute no banco de dados:

```sql
INSERT INTO parameters (scope, instance, `key`, `value`)
VALUES ('INSTANCE', 'sua_instancia', 'customer_linking_bot_enabled', 'true');
```

**Pronto!** O bot já está ativo. 🎉

---

## 📋 Como Funciona

### Fluxo Automático

```
Cliente envia mensagem
    ↓
Tem cliente vinculado? → SIM → Bot NÃO é ativado
    ↓ NÃO
Bot habilitado nos parâmetros? → NÃO → Bot NÃO é ativado
    ↓ SIM
Bot solicita CNPJ
    ↓
Cliente informa CNPJ
    ↓
CNPJ válido? → NÃO → Solicita novamente
    ↓ SIM
Busca cliente no banco
    ↓
Cliente encontrado? → NÃO → Direciona para atendimento humano
    ↓ SIM
Vincula cliente ao contato
    ↓
FIM (atendimento liberado)
```

---

## ⚙️ Configuração

### Parâmetros Disponíveis

| Parâmetro | Valores | Padrão | Descrição |
|-----------|---------|--------|-----------|
| `customer_linking_bot_enabled` | `true` / `false` | `false` | Habilita/desabilita o bot |
| `customer_linking_timeout_ms` | Número (ms) | `600000` | Timeout de inatividade (10 min) |

### Exemplos de Configuração

#### Por Instância (todos os setores/usuários)
```sql
INSERT INTO parameters (scope, instance, `key`, `value`)
VALUES ('INSTANCE', 'exatron', 'customer_linking_bot_enabled', 'true');
```

#### Por Setor (ID 5)
```sql
INSERT INTO parameters (scope, instance, sectorId, `key`, `value`)
VALUES ('SECTOR', 'exatron', 5, 'customer_linking_bot_enabled', 'true');
```

#### Por Usuário (ID 10, Setor 5)
```sql
INSERT INTO parameters (scope, instance, sectorId, userId, `key`, `value`)
VALUES ('USER', 'exatron', 5, 10, 'customer_linking_bot_enabled', 'true');
```

#### Timeout de 5 minutos
```sql
INSERT INTO parameters (scope, instance, `key`, `value`)
VALUES ('INSTANCE', 'exatron', 'customer_linking_timeout_ms', '300000');
```

---

## 💬 Mensagens do Bot

### Interação Típica

**Bot:** Para prosseguir, preciso vincular seu cadastro. Por favor, informe o CNPJ da sua empresa.

**Cliente:** 12.345.678/0001-90

**Bot:** Cliente encontrado! Vinculando seu cadastro...

**Bot:** Cadastro vinculado com sucesso! Você já pode prosseguir com o atendimento.

### Caso CNPJ Inválido

**Cliente:** 123

**Bot:** CNPJ inválido. Por favor, digite um CNPJ válido (apenas números ou com formatação XX.XXX.XXX/XXXX-XX).

### Caso Cliente Não Encontrado

**Bot:** Cliente não encontrado em nossa base de dados. Você será direcionado para atendimento humano.

---

## 🔍 Verificações

### Ver configuração atual
```sql
SELECT * FROM parameters 
WHERE `key` LIKE 'customer_linking%';
```

### Contatos sem cliente vinculado
```sql
SELECT instance, COUNT(*) as total
FROM contacts 
WHERE customer_id IS NULL 
  AND is_deleted = 0
GROUP BY instance;
```

### Verificar sessões ativas
```bash
cat data/customer-linking.sessions.json
```

---

## 🛠️ Solução de Problemas

### Bot não está sendo ativado

✅ **Checklist:**
- [ ] Parâmetro `customer_linking_bot_enabled` está como `true`?
- [ ] Contato realmente não tem `customerId`?
- [ ] Verificar logs do sistema

```sql
-- Verificar parâmetro
SELECT * FROM parameters 
WHERE `key` = 'customer_linking_bot_enabled';

-- Verificar contato
SELECT id, name, phone, customer_id 
FROM contacts 
WHERE phone = 'numero_do_telefone';
```

### Cliente não é encontrado

✅ **Checklist:**
- [ ] CNPJ existe na tabela `clientes`?
- [ ] Campo `CPF_CNPJ` está preenchido?
- [ ] Formato do CNPJ está correto no banco?

```sql
-- No banco da instância
SELECT CODIGO, NOME, CPF_CNPJ 
FROM clientes 
WHERE CPF_CNPJ = '12345678000190';
```

---

## 🎯 Prioridade de Parâmetros

Quando configurado em múltiplos níveis:

```
USER (maior prioridade)
  ↓
SECTOR
  ↓
INSTANCE (menor prioridade)
```

**Exemplo:**
- INSTANCE: `enabled = false`
- SECTOR: `enabled = true`

→ **Resultado:** Bot HABILITADO no setor (SECTOR sobrescreve INSTANCE)

---

## 📊 Monitoramento

### Logs do Bot

O bot registra todas as ações:

```
[customer-linking] Iniciando bot de vinculação de cliente
[customer-linking] Solicitando CNPJ ao cliente
[customer-linking] CNPJ válido recebido: 12345678000190
[customer-linking] Cliente encontrado: 1234
[customer-linking] Vinculando cliente ao contato
[customer-linking] Cliente vinculado com sucesso
```

### Arquivo de Sessões

```bash
# Visualizar sessões ativas
cat data/customer-linking.sessions.json

# Monitorar em tempo real
watch -n 2 cat data/customer-linking.sessions.json
```

---

## 🔄 Desabilitar o Bot

### Temporariamente
```sql
UPDATE parameters 
SET `value` = 'false' 
WHERE `key` = 'customer_linking_bot_enabled';
```

### Permanentemente
```sql
DELETE FROM parameters 
WHERE `key` LIKE 'customer_linking%';
```

---

## 📝 Notas Importantes

- ✅ Bot usa **botId = 3** no chat
- ✅ Sessões são salvas em `data/customer-linking.sessions.json`
- ✅ Timeout padrão: **10 minutos**
- ✅ Formato CNPJ: **14 dígitos** (aceita com ou sem formatação)
- ✅ Tabela de busca: **clientes.CPF_CNPJ**
- ✅ Campo atualizado: **contacts.customer_id**

---

## 🎓 Próximos Passos

Após configurar o bot:

1. ✅ Teste com um contato sem cliente vinculado
2. ✅ Verifique os logs para garantir funcionamento
3. ✅ Ajuste o timeout conforme necessário
4. ✅ Configure por setor/usuário se necessário
5. ✅ Monitore as vinculações realizadas

---

## 📚 Documentação Completa

Para mais detalhes, consulte:
- `CUSTOMER_LINKING_BOT.md` - Documentação completa
- `scripts/configure-customer-linking-bot.sql` - Scripts de configuração
