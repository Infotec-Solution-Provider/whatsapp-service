#!/usr/bin/env bash
set -euo pipefail
umask 077
root=/home/inpulse/htdocs/homolog
hsql="$root/bin/hsql.sh"
source_db=homolog-whatsapp
test_db=homolog-whatsapp-restore-$(date -u +%Y%m%d%H%M%S)
backup=$(mktemp -d "$root/backups/whatsapp-residency.XXXXXXXX")
cnf=$(mktemp "$root/tmp/whatsapp-residency.XXXXXXXX")
trap 'rm -f "$cnf"' EXIT
[[ $("$hsql" "$source_db" -NB -e "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
printf '[client]\nhost=127.0.0.1\nport=3306\nuser=homolog\npassword="%s"\n' "$(tr -d '\r\n' < "$root/.db-password")" > "$cnf"
dump() {
  mysqldump --defaults-extra-file="$cnf" --quick --single-transaction --no-tablespaces --skip-lock-tables --set-gtid-purged=OFF --column-statistics=0 --hex-blob --skip-add-drop-table "$1" | gzip -3 > "$backup/$1.sql.gz"
  gzip -t "$backup/$1.sql.gz"
}
dump "$source_db"
dump homolog-infotec-whatsapp-runtime
(cd "$backup" && sha256sum -- *.sql.gz > SHA256SUMS)
"$hsql" homolog-instances -e "CREATE DATABASE \`$test_db\` CHARACTER SET utf8mb4"
gzip -dc "$backup/$source_db.sql.gz" | "$hsql" "$test_db"
tables=$("$hsql" "$source_db" -NB -e "SELECT table_name FROM information_schema.tables WHERE table_schema=database() AND table_type='BASE TABLE' ORDER BY table_name")
while IFS= read -r tbl; do
  [[ $tbl =~ ^[a-zA-Z0-9_]+$ ]]
  "$hsql" "$source_db" -NB -e "CHECKSUM TABLE \`$source_db\`.\`$tbl\`, \`$test_db\`.\`$tbl\` EXTENDED" |
    awk -v t="$tbl" 'NR==1 {orig=$2} NR==2 {if($2!=orig || $2=="NULL")exit 1; print t,orig} END{if(NR!=2)exit 1}' >> "$backup/restore-checksums"
done <<< "$tables"
[[ $(wc -l < "$backup/restore-checksums") -eq $(wc -l <<< "$tables") ]]
printf 'BACKUP=%s\nRESTORE=%s\nTABLES=%s\n' "$backup" "$test_db" "$(wc -l < "$backup/restore-checksums")"
# This database was just created by this invocation and is never used by the application.
[[ $test_db =~ ^homolog-whatsapp-restore-[0-9]{14}$ ]]
"$hsql" homolog-instances -e "DROP DATABASE \`$test_db\`"
