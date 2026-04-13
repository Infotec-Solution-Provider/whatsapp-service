#!/usr/bin/env bash
# clone-prod-to-tests.sh
# Faz dump do banco inpulse-whatsapp (produção) e importa localmente
# como inpulse-whatsapp-tests, excluindo dados das tabelas de fila/logs.
#
# Uso: ./scripts/clone-prod-to-tests.sh

set -euo pipefail

# ─── Conexão produção ───────────────────────────────────────────────────────
PROD_HOST="82.25.64.46"
PROD_PORT="3306"
PROD_USER="admin"
PROD_PASS="1NF0TEC"
PROD_DB="inpulse-whatsapp"

# ─── Conexão local ──────────────────────────────────────────────────────────
LOCAL_HOST="localhost"
LOCAL_PORT="3306"
LOCAL_USER="renan"
LOCAL_PASS="9231"
LOCAL_DB="inpulse-whatsapp-tests"

# ─── Tabelas que terão schema mas NÃO terão dados ───────────────────────────
# (tabelas pesadas: process_logs ~2GB, filas de webhook ~350MB+)
SKIP_DATA_TABLES=(
  "process_logs"
  "gupshup_webhook_queue"
  "waba_webhook_queue"
  "wpp_message_processing_queue"
  "internal_message_processing_queue"
  "message_queue_items"
)

# ─── Arquivo temporário ─────────────────────────────────────────────────────
DUMP_FILE="/tmp/inpulse-whatsapp-dump-$$.sql.gz"

# ─── Funções de log ─────────────────────────────────────────────────────────
info()  { echo "[INFO]  $*"; }
error() { echo "[ERROR] $*" >&2; }

cleanup() {
  if [[ -f "$DUMP_FILE" ]]; then
    info "Removendo arquivo temporário $DUMP_FILE..."
    rm -f "$DUMP_FILE"
  fi
}
trap cleanup EXIT

# ─── Verificar dependências ──────────────────────────────────────────────────
for cmd in mysqldump mysql gzip gunzip; do
  if ! command -v "$cmd" &>/dev/null; then
    error "Comando '$cmd' não encontrado. Instale o MySQL client e gzip."
    exit 1
  fi
done

# ─── Montagem dos flags --ignore-table para a passagem de dados ──────────────
IGNORE_FLAGS=()
for table in "${SKIP_DATA_TABLES[@]}"; do
  IGNORE_FLAGS+=("--ignore-table=${PROD_DB}.${table}")
done

# ─── Passagem 1: schema completo (todas as tabelas, sem dados) ───────────────
info "Iniciando dump do schema completo de '$PROD_DB' em produção..."
mysqldump \
  --host="$PROD_HOST" \
  --port="$PROD_PORT" \
  --user="$PROD_USER" \
  --password="$PROD_PASS" \
  --single-transaction \
  --no-data \
  --add-drop-table \
  --set-gtid-purged=OFF \
  --no-tablespaces \
  "$PROD_DB" \
  | gzip > "$DUMP_FILE"

info "Schema exportado. Arquivo temporário: $DUMP_FILE"

# ─── Passagem 2: dados (excluindo tabelas pesadas) ────────────────────────────
info "Exportando dados (excluindo tabelas de fila/logs)..."
mysqldump \
  --host="$PROD_HOST" \
  --port="$PROD_PORT" \
  --user="$PROD_USER" \
  --password="$PROD_PASS" \
  --single-transaction \
  --no-create-info \
  --skip-triggers \
  --set-gtid-purged=OFF \
  --no-tablespaces \
  "${IGNORE_FLAGS[@]}" \
  "$PROD_DB" \
  | gzip >> "$DUMP_FILE"

info "Dados exportados."
info "Tamanho do dump: $(du -sh "$DUMP_FILE" | cut -f1)"

# ─── Criar banco local ────────────────────────────────────────────────────────
info "Criando banco '$LOCAL_DB' localmente (se não existir)..."
mysql \
  --host="$LOCAL_HOST" \
  --port="$LOCAL_PORT" \
  --user="$LOCAL_USER" \
  --password="$LOCAL_PASS" \
  --execute="CREATE DATABASE IF NOT EXISTS \`${LOCAL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# ─── Importar dump ────────────────────────────────────────────────────────────
info "Importando dump em '$LOCAL_DB'... (pode demorar alguns minutos)"
gunzip --keep --stdout "$DUMP_FILE" \
  | mysql \
      --host="$LOCAL_HOST" \
      --port="$LOCAL_PORT" \
      --user="$LOCAL_USER" \
      --password="$LOCAL_PASS" \
      "$LOCAL_DB"

# ─── Verificação rápida ────────────────────────────────────────────────────────
info "Verificando importação..."

TABLE_COUNT=$(mysql \
  --host="$LOCAL_HOST" \
  --port="$LOCAL_PORT" \
  --user="$LOCAL_USER" \
  --password="$LOCAL_PASS" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${LOCAL_DB}';")

MSG_COUNT=$(mysql \
  --host="$LOCAL_HOST" \
  --port="$LOCAL_PORT" \
  --user="$LOCAL_USER" \
  --password="$LOCAL_PASS" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM \`${LOCAL_DB}\`.messages;")

LOG_COUNT=$(mysql \
  --host="$LOCAL_HOST" \
  --port="$LOCAL_PORT" \
  --user="$LOCAL_USER" \
  --password="$LOCAL_PASS" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM \`${LOCAL_DB}\`.process_logs;")

info "─────────────────────────────────────────"
info "Banco local: $LOCAL_DB"
info "Tabelas criadas : $TABLE_COUNT"
info "Registros em messages    : $MSG_COUNT"
info "Registros em process_logs: $LOG_COUNT (deve ser 0)"
info "─────────────────────────────────────────"
info "Importação concluída com sucesso!"
