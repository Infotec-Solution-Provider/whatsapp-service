# 🚀 Redis Cache - Quick Start

## Instalação Rápida (5 minutos)

### 0. Instalar Redis (se ainda não tiver)

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server -y
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

**CentOS/RHEL:**
```bash
sudo yum install epel-release -y
sudo yum install redis -y
sudo systemctl start redis
sudo systemctl enable redis
```

**Verificar instalação:**
```bash
redis-cli ping
# Deve retornar: PONG
```

📖 **Guia completo:** `docs/REDIS_LINUX_INSTALL.md`

### 1. Instalar dependências (já instaladas)
```bash
# As dependências já foram instaladas:
# - ioredis
# - @types/ioredis
```

### 2. Configurar .env
```bash
# Adicionar ao arquivo .env:
REDIS_URL="redis://localhost:6379"

# Ou via comando:
echo 'REDIS_URL="redis://localhost:6379"' >> .env
```

### 3. Iniciar aplicação
```bash
npm run dev
```

### 4. Verificar funcionamento
Quando a aplicação conectar com sucesso, você verá:
```
✅ Redis connected successfully
```

## 🧪 Testar

1. Fazer uma requisição para listar contatos
2. Verificar chaves criadas no Redis:
```bash
redis-cli KEYS "*"
```

3. Ver estatísticas:
```bash
redis-cli INFO stats
```

## 📊 Comandos Úteis do Redis

```bash
# Ver todas as chaves
redis-cli KEYS "*"

# Ver clientes em cache
redis-cli KEYS "customer:*"

# Ver usuários em cache
redis-cli KEYS "user:*"

# Limpar cache
redis-cli FLUSHDB

# Monitorar em tempo real
redis-cli MONITOR

# Ver estatísticas
redis-cli INFO stats

# Ver uso de memória
redis-cli INFO memory
```

## 📚 Documentação Completa

- `docs/REDIS_IMPLEMENTATION_SUMMARY.md` - Resumo executivo
- `docs/REDIS_CACHE.md` - Documentação técnica
- `docs/REDIS_DEV_GUIDE.md` - Guia de desenvolvimento

## 🆘 Ajuda

### Redis não inicia
```bash
# Verificar Docker
docker ps

# Ver erro
npm run redis:logs
```

### Aplicação não conecta
```bash
# Verificar .env
cat .env | grep REDIS_URL

# Testar conexão manualmente
npm run redis:cli
> PING
```

### Limpar cache
```bash
npm run redis:clear
```

---

**Dúvidas?** Consulte `docs/REDIS_DEV_GUIDE.md`
