#!/usr/bin/env bash
set -euo pipefail
umask 077
H=/home/inpulse/htdocs/homolog
backup="$H/backups/tenant-sql-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup"
cnf=$(mktemp "$H/tmp/tenant-sql-backup.XXXXXX")
trap 'rm -f "$cnf"' EXIT
printf '[client]\nhost=127.0.0.1\nport=3306\nuser=homolog\npassword="%s"\n' "$(tr -d '\r\n' < "$H/.db-password")" > "$cnf"
mysqldump --defaults-extra-file="$cnf" --single-transaction --no-tablespaces --skip-lock-tables homolog-whatsapp | gzip > "$backup/homolog-whatsapp.sql.gz"
tar -czf "$backup/whatsapp-before.tar.gz" -C "$H/whatsapp" dist .env
tar -czf "$backup/reports-before.tar.gz" -C "$H/reports-service" dist .env
gzip -t "$backup/homolog-whatsapp.sql.gz"
printf '%s\n' "$backup"
