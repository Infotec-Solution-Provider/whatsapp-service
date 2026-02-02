# Implementação de encodeURIComponent para MySQL 5.5 (utf8 mb3)

## Contexto

MySQL 5.5 com charset `utf8` (alias para `utf8mb3`) suporta apenas 3 bytes por caractere, não sendo capaz de armazenar emojis (4 bytes). A solução adotada foi usar `encodeURIComponent` nos campos de texto que podem conter emojis.

## Abordagem

- ✅ **Prepared Statements**: Mantidos para segurança contra SQL injection
- ✅ **Encoding**: Aplicado antes de passar valores para os prepared statements
- ✅ **Decoding**: Aplicado ao ler dados do banco local
- ✅ **Charset**: Tabelas usam `utf8` (mb3)

## Campos Encodados

### 1. Contatos (`wpp_contacts`)
- `name`: Nome do contato pode conter emojis

### 2. Chats (`wpp_chats`)
- `avatar_url`: URL pode conter caracteres especiais

### 3. Mensagens (`wpp_messages`)
- `body`: Corpo da mensagem (principal fonte de emojis)
- `file_name`: Nome de arquivo pode conter caracteres especiais

### 4. Agendamentos (`wpp_schedules`)
- `description`: Descrição pode conter emojis

## Arquivos Modificados

### 1. `src/services/local-sync.service.ts`

**Função de Encoding:**
```typescript
private safeEncode(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        return encodeURIComponent(value);
    } catch (err) {
        console.error(`[LocalSync] Erro ao fazer encode:`, err);
        return value;
    }
}
```

**Aplicação:**
- `syncContacts()`: Linha ~343 - `this.safeEncode(c.name)`
- `syncChats()`: Linha ~414 - `this.safeEncode(chat.avatarUrl)`
- `syncMessages()`: Linhas ~504, ~510 - `this.safeEncode(msg.body)`, `this.safeEncode(msg.fileName)`
- `syncSchedules()`: Linha ~596 - `this.safeEncode(schedule.description)`

**Schemas:**
- Todos os `CREATE TABLE` usam `CHARSET=utf8` (não utf8mb4)
- Comandos `ALTER TABLE ... CONVERT TO CHARACTER SET utf8` para garantir charset correto

### 2. `src/services/monitor.service.ts`

**Função de Decoding:**
```typescript
private safeDecode(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        return decodeURIComponent(value);
    } catch (err) {
        console.error(`[MonitorService] Erro ao fazer decode:`, err);
        return value;
    }
}
```

**Aplicação:**
- `getLocalWhatsappChats()`:
  - Linha ~440: `this.safeDecode(row.contact_name)`
  - Linha ~463: `this.safeDecode(row.avatar_url)`
  - Linha ~515: `this.safeDecode(row.body)`
  - Linha ~520: `this.safeDecode(row.file_name)`
  - Linha ~564: `this.safeDecode(schedule.description)` (schedules dentro de chats)

- `getLocalSchedules()`:
  - Linha ~619: `this.safeDecode(row.contact_name)`
  - Linha ~641: `this.safeDecode(row.description)`

## Comportamento

### Encoding (Escrita)
```
Original: "Olá 👋 Setor Financeiro 💰"
Encoded:  "Ol%C3%A1%20%F0%9F%91%8B%20Setor%20Financeiro%20%F0%9F%92%B0"
```

### Decoding (Leitura)
```
Stored:   "Ol%C3%A1%20%F0%9F%91%8B%20Setor%20Financeiro%20%F0%9F%92%B0"
Decoded:  "Olá 👋 Setor Financeiro 💰"
```

## Vantagens

1. **Compatível com MySQL 5.5**: Não requer utf8mb4
2. **Seguro**: Prepared statements evitam SQL injection
3. **Completo**: Suporta todos os caracteres Unicode incluindo emojis
4. **Robusto**: Try-catch em encode/decode retorna valor original em caso de erro

## Desvantagens

1. **Tamanho**: Strings com emojis crescem ~3x (4 bytes → 12 chars hexadecimais)
2. **Performance**: Overhead de encoding/decoding em cada operação
3. **Busca**: Queries SQL não conseguem buscar por texto original (está encodado)
4. **Manutenção**: Código adicional para encode/decode

## Uso

### Sincronização Completa
```bash
npm run sync:local
```

### Sincronização Seletiva
```bash
# Pular mensagens (mais rápido para testar)
npm run sync:local:instance exatron -- --skip-messages

# Pular múltiplos itens
npm run sync:local -- --skip-messages --skip-schedules
```

## Alternativa

Se conseguir habilitar utf8mb4 no MySQL 5.5:
1. Verificar `my.ini` e adicionar:
   ```ini
   [client]
   default-character-set = utf8mb4

   [mysql]
   default-character-set = utf8mb4

   [mysqld]
   character-set-server = utf8mb4
   collation-server = utf8mb4_unicode_ci
   ```
2. Reiniciar MySQL
3. Trocar schemas para `CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
4. Remover `safeEncode()` e `safeDecode()`
5. Remover chamadas de encode/decode
