# Desenvolvimento Local - Redis Cache

## Quick Start

### 1. Iniciar Redis

```bash
# Usando Docker Compose (recomendado)
docker-compose up -d redis

# Verificar se está rodando
docker-compose ps
```

### 2. Configurar .env

```bash
# Copiar exemplo
cp .env.example .env

# Editar e adicionar
REDIS_URL="redis://localhost:6379"
```

### 3. Iniciar Aplicação

```bash
npm run dev
```

Você deve ver no console:
```
✅ Redis connected successfully
```

## Comandos Úteis

### Redis

```bash
# Iniciar Redis
docker-compose up -d redis

# Parar Redis
docker-compose stop redis

# Ver logs
docker-compose logs -f redis

# Acessar CLI do Redis
docker exec -it whatsapp-redis redis-cli

# Reiniciar Redis (limpa cache)
docker-compose restart redis
```

### Redis Commander (Interface Web)

```bash
# Iniciar interface web (opcional)
docker-compose --profile tools up -d redis-commander

# Acessar em: http://localhost:8081
```

### Verificar Cache

```bash
# Entrar no Redis CLI
docker exec -it whatsapp-redis redis-cli

# Dentro do CLI:
> KEYS *                          # Ver todas as chaves
> KEYS customer:*                 # Ver clientes em cache
> KEYS user:*                     # Ver usuários em cache
> GET customer:karsten:123        # Ver dados de um cliente
> TTL customer:karsten:123        # Ver tempo restante (segundos)
> DEL customer:karsten:123        # Remover do cache
> FLUSHDB                         # Limpar todo o cache
> INFO stats                      # Ver estatísticas
```

## Troubleshooting

### "Redis connection error: ECONNREFUSED"

```bash
# Verificar se Redis está rodando
docker-compose ps

# Se não estiver, iniciar
docker-compose up -d redis

# Ver logs de erro
docker-compose logs redis
```

### "Redis not ready, skipping operation"

✅ Isso é **normal** e esperado!  
A aplicação continua funcionando, apenas sem cache.

Para resolver:
```bash
# Verificar conexão
docker exec -it whatsapp-redis redis-cli ping
# Deve retornar: PONG
```

### Cache não está funcionando

```bash
# 1. Verificar variável de ambiente
cat .env | grep REDIS_URL

# 2. Testar conexão manual
docker exec -it whatsapp-redis redis-cli ping

# 3. Monitorar comandos Redis em tempo real
docker exec -it whatsapp-redis redis-cli monitor

# 4. Fazer uma requisição e verificar se aparecem comandos MGET/MSET
```

### Limpar cache completamente

```bash
# Método 1: Via CLI
docker exec -it whatsapp-redis redis-cli FLUSHDB

# Método 2: Reiniciar container (perde tudo)
docker-compose down redis
docker-compose up -d redis
```

## Desenvolvimento

### Testar sem Redis

```bash
# Parar Redis
docker-compose stop redis

# Aplicação continua funcionando (sem cache)
```

### Ver uso de memória

```bash
docker exec -it whatsapp-redis redis-cli INFO memory

# Ou via stats
docker stats whatsapp-redis
```

### Performance Testing

```bash
# Teste de latência
docker exec -it whatsapp-redis redis-cli --latency

# Teste de throughput
docker exec -it whatsapp-redis redis-cli --latency-history

# Ver comandos lentos
docker exec -it whatsapp-redis redis-cli SLOWLOG GET 10
```

## Estrutura de Dados

### Formato das Chaves

```
customer:<instance>:<customerId>
user:<instance>:<userId>
```

### Exemplo de Dados Armazenados

```json
// customer:karsten:12345
{
  "CODIGO": 12345,
  "RAZAO": "Empresa LTDA",
  "FANTASIA": "Empresa",
  "CPF_CNPJ": "12345678000123",
  "COD_ERP": "ERP001",
  ...
}

// user:karsten:10
{
  "CODIGO": 10,
  "NOME": "João Silva",
  "EMAIL": "joao@empresa.com",
  ...
}
```

## Produção

### Configuração Recomendada

```bash
# .env de produção
REDIS_URL="redis://:senha_forte@redis-prod:6379"
```

### Docker Compose para Produção

```yaml
services:
  redis:
    image: redis:7-alpine
    command: >
      redis-server
      --requirepass senha_forte
      --appendonly yes
      --maxmemory 1gb
      --maxmemory-policy allkeys-lru
    volumes:
      - /data/redis:/data
    restart: always
```

### Backup Redis

```bash
# Backup manual
docker exec whatsapp-redis redis-cli BGSAVE

# Arquivo salvo em: /data/dump.rdb (dentro do container)

# Copiar backup
docker cp whatsapp-redis:/data/dump.rdb ./backup-$(date +%Y%m%d).rdb
```

## Monitoramento

### Métricas Importantes

```bash
# Via Redis CLI
docker exec -it whatsapp-redis redis-cli INFO stats

# Principais métricas:
# - total_commands_processed: Total de comandos
# - instantaneous_ops_per_sec: Operações/segundo
# - keyspace_hits: Cache hits
# - keyspace_misses: Cache misses
# - used_memory_human: Memória usada
```

### Cache Hit Rate

```bash
# Calcular hit rate
docker exec -it whatsapp-redis redis-cli INFO stats | grep keyspace

# Formula: hits / (hits + misses) * 100
```

## Recursos Adicionais

- [Redis Documentation](https://redis.io/docs/)
- [ioredis GitHub](https://github.com/redis/ioredis)
- [Redis Best Practices](https://redis.io/docs/manual/patterns/)
