# Cache Configuration Guide

## Overview

O serviço agora suporta dois provedores de cache:
- **Redis** (padrão) - Para produção e ambientes com suporte
- **Memory Cache** - Para desenvolvimento e ambientes sem Redis

## Configuration

Configure o provedor de cache através da variável de ambiente `CACHE_PROVIDER`:

### Usar Redis (Padrão)

```bash
# .env ou variáveis de ambiente
CACHE_PROVIDER=redis
REDIS_URL=redis://localhost:6379
```

### Usar Cache em Memória

```bash
# .env ou variáveis de ambiente
CACHE_PROVIDER=memory
```

## Usage

O uso do serviço permanece idêntico, independentemente do provedor:

```typescript
import CacheService from "./services/redis.service";

// Salvar valor
await CacheService.set("user:123", { name: "João" }, 3600); // TTL de 1 hora

// Recuperar valor
const user = await CacheService.get<User>("user:123");

// Salvar múltiplos valores
await CacheService.mset([
  { key: "session:abc", value: sessionData, ttl: 1800 },
  { key: "config:app", value: configData }
]);

// Recuperar múltiplos valores
const values = await CacheService.mget<any>(["key1", "key2", "key3"]);

// Verificar existência
const exists = await CacheService.exists("user:123");

// Definir expiração
await CacheService.expire("user:123", 7200); // 2 horas

// Deletar valor
await CacheService.del("user:123");

// Deletar múltiplos valores
await CacheService.mdel(["key1", "key2"]);

// Limpar por padrão
await CacheService.clear("user:*"); // Remove todas as chaves que começam com "user:"

// Verificar se cache está pronto
if (CacheService.isReady()) {
  // Cache disponível
}

// Desconectar (normalmente ao encerrar aplicação)
await CacheService.disconnect();
```

## Características do Memory Cache

### Expiração Automática
- Chaves expiradas são removidas automaticamente a cada 60 segundos
- Chaves expiradas são também removidas ao serem acessadas

### Padrões de Limpeza
O método `clear(pattern)` suporta padrões glob simples:
```typescript
await CacheService.clear("user:*");      // Remove user:1, user:2, etc
await CacheService.clear("session:*");   // Remove session:abc, session:xyz, etc
await CacheService.clear("*");           // Remove todas as chaves
```

### Debug e Monitoramento
Para ambientes de desenvolvimento, você pode obter informações sobre o cache em memória:

```typescript
// Obter estatísticas (apenas para memory cache)
import MemoryCacheService from "./services/memory-cache.service";

const stats = MemoryCacheService.getStats();
console.log(`Cache size: ${stats.size} items`);
console.log(`Keys: ${stats.keys.join(", ")}`);
```

## Performance Considerations

### Redis
- ✅ Melhor para ambientes multi-processo
- ✅ Suporta persistência
- ✅ Escalável para grandes volumes
- ⚠️ Requer infraestrutura adicional

### Memory Cache
- ✅ Sem dependências externas
- ✅ Rápido para desenvolvimento e testes
- ✅ Sem latência de rede
- ⚠️ Limitado à memória do processo
- ⚠️ Não compartilhado entre instâncias

## Docker Compose

Se estiver usando Docker, configure assim:

```yaml
# docker-compose.yml - Exemplo com Redis
version: '3'
services:
  app:
    environment:
      - CACHE_PROVIDER=redis
      - REDIS_URL=redis://redis:6379
  
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
```

```yaml
# docker-compose.yml - Exemplo sem Redis
version: '3'
services:
  app:
    environment:
      - CACHE_PROVIDER=memory
```

## Migration Guide

Se você estava usando apenas Redis e quer adicionar suporte a memory cache:

1. **Nenhuma mudança necessária no código!** O serviço é transparente.
2. Configure a variável `CACHE_PROVIDER` no ambiente
3. O serviço detectará automaticamente e usará o provedor correto

## Troubleshooting

### Cache em memória cresce muito
Verifique se as chaves têm TTL definido:
```typescript
// ❌ Errado - sem TTL, chave nunca expira
await CacheService.set("mykey", value);

// ✅ Correto - com TTL
await CacheService.set("mykey", value, 3600); // 1 hora
```

### Redis connection timeout
Verifique a variável `REDIS_URL`:
```bash
# Formato correto
REDIS_URL=redis://localhost:6379
REDIS_URL=redis://user:password@hostname:6379/0
```

### Alternando entre provedores
Se trocou de provedor, o cache anterior será perdido (é armazenado em local diferente).
