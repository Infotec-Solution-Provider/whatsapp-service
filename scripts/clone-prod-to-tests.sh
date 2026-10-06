#!/usr/bin/env bash
# clone-prod-to-tests.sh
# Faz dump do banco inpulse-whatsapp (produção) e importa localmente
# como inpulse-whatsapp-tests, excluindo dados das tabelas de fila/logs.
#
# Uso: ./scripts/clone-prod-to-tests.sh
#
# As conexões vêm somente de variáveis de ambiente (nenhum valor fica gravado aqui):
#   CLONE_PROD_DB_HOST       host do MySQL de produção (obrigatória)
#   CLONE_PROD_DB_PORT       porta de produção (padrão: 3306)
#   CLONE_PROD_DB_USER       usuário de produção (obrigatória; prefira um usuário só de leitura)
#   CLONE_PROD_DB_PASSWORD   senha de produção (obrigatória)
#   CLONE_PROD_DB_NAME       banco de origem (padrão: inpulse-whatsapp)
#   CLONE_LOCAL_DB_HOST      host do MySQL local (padrão: 127.0.0.1)
#   CLONE_LOCAL_DB_PORT      porta local (padrão: 3306)
#   CLONE_LOCAL_DB_USER      usuário local (obrigatória)
#   CLONE_LOCAL_DB_PASSWORD  senha local (pode ser vazia, mas precisa estar definida)
#   CLONE_LOCAL_DB_NAME      banco de destino (padrão: inpulse-whatsapp-tests)
#
# Exemplo, sem deixar a senha no histórico do shell:
#   read -rs CLONE_PROD_DB_PASSWORD && export CLONE_PROD_DB_PASSWORD
#   export CLONE_PROD_DB_HOST=... CLONE_PROD_DB_USER=... CLONE_LOCAL_DB_USER=root CLONE_LOCAL_DB_PASSWORD=
#   ./scripts/clone-prod-to-tests.sh
#
# As senhas vão para arquivos de opções temporários (permissão 600, apagados ao
# final) e nunca aparecem na linha de comando do mysql/mysqldump.
#
# ATENÇÃO: versões antigas deste arquivo tinham host, usuário e senha de produção
# gravados no código. Esses valores continuam no histórico do git: a senha precisa
# ser rotacionada pelo dono do banco.

set -euo pipefail

# ─── Conexões (somente por variáveis de ambiente; nunca grave valores aqui) ───
PROD_HOST="${CLONE_PROD_DB_HOST:-}"
PROD_PORT="${CLONE_PROD_DB_PORT:-3306}"
PROD_USER="${CLONE_PROD_DB_USER:-}"
PROD_PASS="${CLONE_PROD_DB_PASSWORD:-}"
PROD_DB="${CLONE_PROD_DB_NAME:-inpulse-whatsapp}"
LOCAL_HOST="${CLONE_LOCAL_DB_HOST:-127.0.0.1}"
LOCAL_PORT="${CLONE_LOCAL_DB_PORT:-3306}"
LOCAL_USER="${CLONE_LOCAL_DB_USER:-}"
LOCAL_DB="${CLONE_LOCAL_DB_NAME:-inpulse-whatsapp-tests}"
missing=()
for var in CLONE_PROD_DB_HOST CLONE_PROD_DB_USER CLONE_PROD_DB_PASSWORD CLONE_LOCAL_DB_USER; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
[[ -n "${CLONE_LOCAL_DB_PASSWORD+x}" ]] || missing+=("CLONE_LOCAL_DB_PASSWORD")
if (( ${#missing[@]} > 0 )); then
  echo "[ERROR] Defina as variáveis de ambiente: ${missing[*]} (CLONE_LOCAL_DB_PASSWORD pode ser vazia, mas precisa existir)." >&2
  exit 1
fi
LOCAL_PASS="${CLONE_LOCAL_DB_PASSWORD}"

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

# ─── Arquivos temporários ───────────────────────────────────────────────────
DUMP_FILE="/tmp/inpulse-whatsapp-dump-$$.sql.gz"
# Arquivos de opções do cliente MySQL com as credenciais (criados mais abaixo)
PROD_CNF=""
LOCAL_CNF=""

# ─── Funções de log ─────────────────────────────────────────────────────────
info()  { echo "[INFO]  $*"; }
error() { echo "[ERROR] $*" >&2; }

cleanup() {
  if [[ -f "$DUMP_FILE" ]]; then
    info "Removendo arquivo temporário $DUMP_FILE..."
    rm -f "$DUMP_FILE"
  fi
  if [[ -n "${PROD_CNF:-}" ]]; then
    rm -f "$PROD_CNF"
  fi
  if [[ -n "${LOCAL_CNF:-}" ]]; then
    rm -f "$LOCAL_CNF"
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

# ─── Credenciais em arquivos de opções (fora da linha de comando) ────────────
for value in "$PROD_HOST" "$PROD_PORT" "$PROD_USER" "$PROD_PASS" "$LOCAL_HOST" "$LOCAL_PORT" "$LOCAL_USER" "$LOCAL_PASS"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    error "As variáveis CLONE_PROD_DB_* e CLONE_LOCAL_DB_* não podem conter quebras de linha."
    exit 1
  fi
done

# Valor entre aspas duplas, escapando barra invertida e aspas (sintaxe do arquivo de opções do MySQL).
cnf_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

write_client_cnf() {
  local file="$1" host="$2" port="$3" user="$4" pass="$5"
  printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' \
    "$host" "$port" "$user" "$(cnf_quote "$pass")" > "$file"
}

umask 077
PROD_CNF="$(mktemp)"
LOCAL_CNF="$(mktemp)"
write_client_cnf "$PROD_CNF" "$PROD_HOST" "$PROD_PORT" "$PROD_USER" "$PROD_PASS"
write_client_cnf "$LOCAL_CNF" "$LOCAL_HOST" "$LOCAL_PORT" "$LOCAL_USER" "$LOCAL_PASS"

# ─── Montagem dos flags --ignore-table para a passagem de dados ──────────────
IGNORE_FLAGS=()
for table in "${SKIP_DATA_TABLES[@]}"; do
  IGNORE_FLAGS+=("--ignore-table=${PROD_DB}.${table}")
done

# ─── Passagem 1: schema completo (todas as tabelas, sem dados) ───────────────
info "Iniciando dump do schema completo de '$PROD_DB' em produção..."
mysqldump \
  --defaults-extra-file="$PROD_CNF" \
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
  --defaults-extra-file="$PROD_CNF" \
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
  --defaults-extra-file="$LOCAL_CNF" \
  --execute="CREATE DATABASE IF NOT EXISTS \`${LOCAL_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# ─── Importar dump ────────────────────────────────────────────────────────────
info "Importando dump em '$LOCAL_DB'... (pode demorar alguns minutos)"
gunzip --keep --stdout "$DUMP_FILE" \
  | mysql \
      --defaults-extra-file="$LOCAL_CNF" \
      "$LOCAL_DB"

# ─── Verificação rápida ────────────────────────────────────────────────────────
info "Verificando importação..."

TABLE_COUNT=$(mysql \
  --defaults-extra-file="$LOCAL_CNF" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${LOCAL_DB}';")

MSG_COUNT=$(mysql \
  --defaults-extra-file="$LOCAL_CNF" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM \`${LOCAL_DB}\`.messages;")

LOG_COUNT=$(mysql \
  --defaults-extra-file="$LOCAL_CNF" \
  --silent --skip-column-names \
  --execute="SELECT COUNT(*) FROM \`${LOCAL_DB}\`.process_logs;")

info "─────────────────────────────────────────"
info "Banco local: $LOCAL_DB"
info "Tabelas criadas : $TABLE_COUNT"
info "Registros em messages    : $MSG_COUNT"
info "Registros em process_logs: $LOG_COUNT (deve ser 0)"
info "─────────────────────────────────────────"
info "Importação concluída com sucesso!"
