# 🚀 Redis Cache - Quick Start

## Instalação Rápida (5 minutos)

### 1. Instalar dependências
```bash
# As dependências já foram instaladas:
# - ioredis
# - @types/ioredis
```

### 2. Iniciar Redis
```bash
npm run redis:start
```

### 3. Configurar .env
```bash
# Adicionar ao arquivo .env:
REDIS_URL="redis://localhost:6379"
```

### 4. Iniciar aplicação
```bash
npm run dev
```

### 5. Verificar funcionamento
```bash
# Em outro terminal, verificar logs do Redis
npm run redis:logs

# Ou monitorar comandos em tempo real
npm run redis:monitor
```

## ✅ Pronto!

Quando a aplicação conectar com sucesso, você verá:
```
✅ Redis connected successfully
```

## 🧪 Testar

1. Fazer uma requisição para listar contatos
2. Verificar chaves criadas no Redis:
```bash
npm run redis:keys
```

3. Ver estatísticas:
```bash
npm run redis:stats
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
