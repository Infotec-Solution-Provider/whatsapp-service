# 🚀 Instalação Redis no Linux - Guia Rápido

## Ubuntu/Debian (Recomendado)

### Passo 1: Instalar Redis
```bash
sudo apt update
sudo apt install redis-server -y
```

### Passo 2: Configurar Redis
```bash
# Editar configuração (opcional, mas recomendado para produção)
sudo nano /etc/redis/redis.conf

# Encontre e modifique estas linhas:
# supervised no  →  supervised systemd
# bind 127.0.0.1 →  bind 127.0.0.1 (manter para segurança)
```

### Passo 3: Iniciar Redis
```bash
# Iniciar serviço
sudo systemctl start redis-server

# Habilitar para iniciar automaticamente no boot
sudo systemctl enable redis-server

# Verificar status
sudo systemctl status redis-server
```

### Passo 4: Testar Conexão
```bash
# Abrir CLI do Redis
redis-cli

# Dentro do CLI, testar:
> PING
# Deve retornar: PONG

> SET teste "funcionando"
> GET teste
# Deve retornar: "funcionando"

> EXIT
```

### Passo 5: Configurar Aplicação
```bash
# Adicionar ao arquivo .env
echo 'REDIS_URL="redis://localhost:6379"' >> .env

# Ou editar manualmente:
nano .env
# Adicionar: REDIS_URL="redis://localhost:6379"
```

### Passo 6: Iniciar Aplicação
```bash
npm run dev
```

Você deve ver no console:
```
✅ Redis connected successfully
```

---

## CentOS/RHEL/Amazon Linux

### Passo 1: Instalar EPEL e Redis
```bash
sudo yum install epel-release -y
sudo yum install redis -y
```

### Passo 2: Iniciar Redis
```bash
sudo systemctl start redis
sudo systemctl enable redis
sudo systemctl status redis
```

### Passo 3: Testar
```bash
redis-cli ping
# Deve retornar: PONG
```

### Passo 4: Configurar .env
```bash
echo 'REDIS_URL="redis://localhost:6379"' >> .env
```

---

## Comandos Úteis

### Gerenciar Serviço
```bash
# Iniciar
sudo systemctl start redis-server

# Parar
sudo systemctl stop redis-server

# Reiniciar
sudo systemctl restart redis-server

# Status
sudo systemctl status redis-server

# Ver logs
sudo journalctl -u redis-server -f
```

### Monitorar Redis
```bash
# Ver estatísticas
redis-cli INFO stats

# Monitorar comandos em tempo real
redis-cli MONITOR

# Ver todas as chaves
redis-cli KEYS "*"

# Limpar cache
redis-cli FLUSHDB
```

### Verificar Memória
```bash
# Uso de memória
redis-cli INFO memory

# Uso do sistema
free -h
```

---

## Configuração para Produção (Recomendada)

### 1. Definir Senha
```bash
# Editar configuração
sudo nano /etc/redis/redis.conf

# Adicionar/descomentar:
requirepass SuaSenhaForteAqui123

# Salvar e reiniciar
sudo systemctl restart redis-server
```

**Atualizar .env:**
```bash
REDIS_URL="redis://:SuaSenhaForteAqui123@localhost:6379"
```

### 2. Limitar Memória
```bash
# No redis.conf, adicionar:
maxmemory 256mb
maxmemory-policy allkeys-lru
```

### 3. Habilitar Persistência
```bash
# No redis.conf, garantir que está habilitado:
appendonly yes
appendfsync everysec
```

Reiniciar:
```bash
sudo systemctl restart redis-server
```

---

## Segurança (Firewall)

### Permitir apenas localhost (recomendado)
```bash
# No redis.conf:
bind 127.0.0.1 ::1

# Reiniciar
sudo systemctl restart redis-server
```

### Se precisar acesso remoto (não recomendado)
```bash
# Abrir porta no firewall
sudo ufw allow 6379/tcp

# Configurar bind no redis.conf
bind 0.0.0.0

# IMPORTANTE: Configure senha!
requirepass SenhaMuitoForte
```

---

## Troubleshooting

### Redis não inicia
```bash
# Ver logs de erro
sudo journalctl -xeu redis-server

# Verificar porta
sudo netstat -tulpn | grep 6379

# Testar configuração
redis-server /etc/redis/redis.conf --test-memory 2000
```

### Permissões
```bash
# Corrigir permissões
sudo chown redis:redis /var/lib/redis
sudo chmod 755 /var/lib/redis
```

### Aplicação não conecta
```bash
# Verificar se Redis está rodando
sudo systemctl status redis-server

# Testar conexão local
redis-cli ping

# Verificar .env
cat .env | grep REDIS_URL

# Ver logs da aplicação
npm run dev
```

---

## Verificação Final

Execute este checklist:

```bash
# 1. Redis está rodando?
sudo systemctl status redis-server
# ✅ Deve mostrar: active (running)

# 2. Redis responde?
redis-cli ping
# ✅ Deve retornar: PONG

# 3. .env configurado?
grep REDIS_URL .env
# ✅ Deve mostrar: REDIS_URL="redis://localhost:6379"

# 4. Aplicação conecta?
npm run dev
# ✅ Deve mostrar: "✅ Redis connected successfully"
```

---

## Backup e Manutenção

### Backup Manual
```bash
# Forçar salvamento
redis-cli BGSAVE

# Copiar dump
sudo cp /var/lib/redis/dump.rdb /backup/dump-$(date +%Y%m%d).rdb
```

### Monitoramento Contínuo
```bash
# Ver uso de memória
watch -n 1 redis-cli INFO memory | grep used_memory_human

# Ver número de chaves
watch -n 1 redis-cli DBSIZE
```

---

## 🎯 Resumo - TL;DR

```bash
# Instalar
sudo apt update && sudo apt install redis-server -y

# Iniciar
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Testar
redis-cli ping

# Configurar app
echo 'REDIS_URL="redis://localhost:6379"' >> .env

# Rodar app
npm run dev
```

**Pronto! Redis instalado e funcionando! 🚀**
