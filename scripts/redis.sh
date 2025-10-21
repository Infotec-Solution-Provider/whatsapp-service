#!/bin/bash

# Script para gerenciar Redis no desenvolvimento local

ACTION=${1:-"start"}

# Detectar qual versão do docker-compose usar
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
elif docker compose version &> /dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
else
    echo "❌ Docker Compose não encontrado!"
    echo "Instale Docker Desktop ou docker-compose"
    exit 1
fi

case $ACTION in
  start)
    echo "🚀 Iniciando Redis..."
    $DOCKER_COMPOSE up -d redis
    echo "✅ Redis iniciado!"
    echo "📊 Para ver logs: npm run redis:logs"
    echo "🔧 Para acessar CLI: npm run redis:cli"
    ;;
    
  stop)
    echo "🛑 Parando Redis..."
    $DOCKER_COMPOSE stop redis
    echo "✅ Redis parado!"
    ;;
    
  restart)
    echo "🔄 Reiniciando Redis..."
    $DOCKER_COMPOSE restart redis
    echo "✅ Redis reiniciado!"
    ;;
    
  logs)
    echo "📋 Logs do Redis:"
    $DOCKER_COMPOSE logs -f redis
    ;;
    
  cli)
    echo "🔧 Abrindo Redis CLI..."
    docker exec -it whatsapp-redis redis-cli
    ;;
    
  stats)
    echo "📊 Estatísticas do Redis:"
    docker exec -it whatsapp-redis redis-cli INFO stats
    ;;
    
  keys)
    echo "🔑 Chaves no Redis:"
    docker exec -it whatsapp-redis redis-cli KEYS "*"
    ;;
    
  clear)
    echo "🗑️  Limpando cache..."
    docker exec -it whatsapp-redis redis-cli FLUSHDB
    echo "✅ Cache limpo!"
    ;;
    
  monitor)
    echo "👁️  Monitorando comandos Redis em tempo real..."
    echo "Pressione Ctrl+C para sair"
    docker exec -it whatsapp-redis redis-cli MONITOR
    ;;
    
  ui)
    echo "🎨 Iniciando Redis Commander (UI Web)..."
    $DOCKER_COMPOSE --profile tools up -d redis-commander
    echo "✅ Redis Commander disponível em: http://localhost:8081"
    ;;
    
  *)
    echo "❌ Comando inválido!"
    echo ""
    echo "Uso: npm run redis:<comando>"
    echo ""
    echo "Comandos disponíveis:"
    echo "  start    - Inicia o Redis"
    echo "  stop     - Para o Redis"
    echo "  restart  - Reinicia o Redis"
    echo "  logs     - Mostra logs do Redis"
    echo "  cli      - Abre Redis CLI"
    echo "  stats    - Mostra estatísticas"
    echo "  keys     - Lista todas as chaves"
    echo "  clear    - Limpa todo o cache"
    echo "  monitor  - Monitora comandos em tempo real"
    echo "  ui       - Inicia interface web (porta 8081)"
    ;;
esac
