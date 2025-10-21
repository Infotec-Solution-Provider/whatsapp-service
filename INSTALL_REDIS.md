# ⚡ Instalação Redis - 3 Comandos

## Opção 1: Script Automático (Recomendado)

```bash
bash install-redis.sh
```

**Pronto!** O script instala, configura e testa tudo automaticamente.

---

## Opção 2: Manual (Ubuntu/Debian)

```bash
# 1. Instalar Redis
sudo apt update && sudo apt install redis-server -y && sudo systemctl start redis-server && sudo systemctl enable redis-server

# 2. Configurar .env
echo 'REDIS_URL="redis://localhost:6379"' >> .env

# 3. Iniciar aplicação
npm run dev
```

---

## Opção 3: Manual (CentOS/RHEL)

```bash
# 1. Instalar Redis
sudo yum install epel-release -y && sudo yum install redis -y && sudo systemctl start redis && sudo systemctl enable redis

# 2. Configurar .env
echo 'REDIS_URL="redis://localhost:6379"' >> .env

# 3. Iniciar aplicação
npm run dev
```

---

## ✅ Verificar se Funcionou

```bash
# Redis está rodando?
redis-cli ping
# Deve retornar: PONG

# Aplicação conectou?
npm run dev
# Deve mostrar: ✅ Redis connected successfully
```

---

## 🔧 Comandos Úteis

```bash
# Ver cache
redis-cli KEYS "*"

# Limpar cache
redis-cli FLUSHDB

# Ver estatísticas
redis-cli INFO stats

# Reiniciar Redis
sudo systemctl restart redis-server
```

---

## 🆘 Problemas?

### Redis não instala
```bash
# Verificar gerenciador de pacotes
which apt || which yum
```

### Redis não inicia
```bash
# Ver erro
sudo systemctl status redis-server
sudo journalctl -xeu redis-server
```

### Aplicação não conecta
```bash
# Verificar .env
cat .env | grep REDIS_URL

# Testar Redis
redis-cli ping
```

---

## 📚 Documentação Completa

- **Quick Start:** `REDIS_QUICK_START.md`
- **Guia Linux:** `docs/REDIS_LINUX_INSTALL.md`
- **Resumo Técnico:** `docs/REDIS_IMPLEMENTATION_SUMMARY.md`
