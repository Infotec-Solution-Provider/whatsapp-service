#!/bin/bash

# 🚀 Script de Instalação Automática do Redis
# Execute com: bash install-redis.sh

echo "🚀 Instalando Redis no Linux..."
echo ""

# Detectar distribuição
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
else
    echo "❌ Não foi possível detectar a distribuição Linux"
    exit 1
fi

# Instalar Redis baseado na distribuição
case $OS in
    ubuntu|debian)
        echo "📦 Detectado: Ubuntu/Debian"
        echo "Instalando Redis..."
        sudo apt update
        sudo apt install redis-server -y
        ;;
    centos|rhel|fedora|amzn)
        echo "📦 Detectado: CentOS/RHEL/Fedora"
        echo "Instalando Redis..."
        sudo yum install epel-release -y
        sudo yum install redis -y
        ;;
    *)
        echo "❌ Distribuição não suportada: $OS"
        echo "Instale manualmente: sudo apt install redis-server"
        exit 1
        ;;
esac

echo ""
echo "⚙️  Configurando Redis..."

# Iniciar e habilitar serviço
if systemctl is-active --quiet redis-server; then
    sudo systemctl restart redis-server
    sudo systemctl enable redis-server
elif systemctl is-active --quiet redis; then
    sudo systemctl restart redis
    sudo systemctl enable redis
else
    echo "⚠️  Tentando iniciar redis-server..."
    sudo systemctl start redis-server 2>/dev/null || sudo systemctl start redis
    sudo systemctl enable redis-server 2>/dev/null || sudo systemctl enable redis
fi

echo ""
echo "🧪 Testando conexão..."

# Testar Redis
if redis-cli ping > /dev/null 2>&1; then
    echo "✅ Redis instalado e funcionando!"
else
    echo "❌ Redis instalado mas não está respondendo"
    echo "Tente: sudo systemctl status redis-server"
    exit 1
fi

echo ""
echo "⚙️  Configurando aplicação..."

# Verificar se .env existe
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        echo "📝 Criando .env a partir de .env.example..."
        cp .env.example .env
    else
        echo "📝 Criando .env..."
        touch .env
    fi
fi

# Adicionar REDIS_URL se não existir
if ! grep -q "REDIS_URL" .env; then
    echo 'REDIS_URL="redis://localhost:6379"' >> .env
    echo "✅ REDIS_URL adicionado ao .env"
else
    echo "⚠️  REDIS_URL já existe no .env"
fi

echo ""
echo "🎉 Instalação concluída!"
echo ""
echo "📋 Verificação:"
echo "   Redis rodando: $(redis-cli ping 2>/dev/null || echo 'NÃO')"
echo "   Porta: 6379"
echo "   .env configurado: $(grep REDIS_URL .env 2>/dev/null | cut -d'=' -f1)"
echo ""
echo "🚀 Próximos passos:"
echo "   1. Verificar .env: cat .env | grep REDIS_URL"
echo "   2. Iniciar aplicação: npm run dev"
echo "   3. Verificar conexão nos logs: ✅ Redis connected successfully"
echo ""
echo "📚 Documentação:"
echo "   - Quick Start: REDIS_QUICK_START.md"
echo "   - Guia Completo: docs/REDIS_LINUX_INSTALL.md"
echo ""
echo "🔧 Comandos úteis:"
echo "   redis-cli ping         # Testar conexão"
echo "   redis-cli KEYS \"*\"     # Ver chaves"
echo "   redis-cli FLUSHDB      # Limpar cache"
echo "   redis-cli MONITOR      # Monitorar comandos"
echo ""
