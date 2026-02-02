# Local Sync - Guia de Uso

## Comandos Disponíveis

### Sincronizar todas as instâncias
```bash
npm run sync:local
```

### Sincronizar uma instância específica
```bash
npm run sync:local:instance karsten
```

## Opções de Skip

Você pode pular determinadas partes da sincronização usando as flags `--skip-*`:

### Flags disponíveis:
- `--skip-contacts` - Pula sincronização de contatos
- `--skip-sectors` - Pula sincronização de setores de contatos
- `--skip-chats` - Pula sincronização de chats
- `--skip-messages` - Pula sincronização de mensagens
- `--skip-schedules` - Pula sincronização de agendamentos

### Exemplos de uso:

#### Sincronizar tudo exceto mensagens (mais rápido)
```bash
npm run sync:local -- --skip-messages
```

#### Sincronizar apenas contatos e chats
```bash
npm run sync:local -- --skip-messages --skip-schedules --skip-sectors
```

#### Sincronizar uma instância específica pulando mensagens
```bash
npm run sync:local:instance karsten --skip-messages
```

#### Sincronizar apenas estrutura (sem mensagens e agendamentos)
```bash
npm run sync:local -- --skip-messages --skip-schedules
```

#### Sincronizar todas as instâncias pulando várias coisas
```bash
npm run sync:local -- --skip-messages --skip-chats --skip-schedules
```

## Cenários de Uso

### 1. Primeira sincronização (completa)
```bash
npm run sync:local
```

### 2. Atualização rápida (sem mensagens históricas)
```bash
npm run sync:local -- --skip-messages
```

### 3. Apenas estrutura organizacional
```bash
npm run sync:local -- --skip-messages --skip-schedules --skip-chats
```

### 4. Debug de uma instância específica
```bash
npm run sync:local:instance nunes --skip-messages --skip-schedules
```

## Notas

- As mensagens são a parte mais pesada da sincronização
- Pular mensagens (`--skip-messages`) pode acelerar drasticamente o processo
- As tabelas sempre são criadas/verificadas mesmo com skip ativado
- Os skips funcionam tanto para sincronização de todas instâncias quanto para uma específica
