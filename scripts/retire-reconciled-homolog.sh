#!/usr/bin/env bash
set -euo pipefail
umask 077
h=/home/inpulse/htdocs/homolog
d=$(cd -- "$(dirname -- "$0")" && pwd -P)
backup=${1:?Verified backup directory required}
[[ "$backup" == "$h"/backups/whatsapp-residency.* && -s "$backup/restore-checksums" ]]
(cd "$backup" && sha256sum --quiet --check SHA256SUMS)
db=homolog-whatsapp
s(){ "$h/bin/hsql.sh" "$db" -NB -e "$1"; }
tables=(_sector_clients contacts_sectors wpp_message_processing_queue message_reactions operator_outbound_send schedules chat_transfer_history messages chats wallets sectors session_changes session_change_streams waba_webhook_queue gupshup_webhook_queue remote_inbound_event_inbox)
check_db=$db
check_file=check-retirement-homolog.sql
case ${2:---reconciled} in
  --reconciled) ;;
  --remaining)
    tables=(client_session_events client_session_snapshots clients contacts customer_profile_tags message_flows message_flows_steps parameters)
    check_db=homolog-crm-suprimaxxi
    check_file=check-remaining-homolog.sql
    ;;
  *) exit 2 ;;
esac
[[ $(s "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
[[ -e "$h/whatsapp/homolog-central-ingress.enabled" ]]
curl -fsS http://127.0.0.1:7105/health | grep -q '"storage":"tenant-sql"'
quoted=$(printf "'%s'," "${tables[@]}"); quoted=${quoted%,}
[[ $(s "SELECT COUNT(*) FROM information_schema.key_column_usage WHERE referenced_table_schema=DATABASE() AND referenced_table_name IN ($quoted) AND (table_schema<>DATABASE() OR table_name NOT IN ($quoted))") == 0 ]]
[[ $(s "SELECT COUNT(*) FROM information_schema.view_table_usage WHERE table_schema=DATABASE() AND table_name IN ($quoted)") == 0 ]]
[[ $(s "SELECT COUNT(*) FROM information_schema.events WHERE event_schema=DATABASE()") == 0 ]]
out=$("$h/bin/hsql.sh" "$check_db" -NB < "$d/$check_file")
awk -v n="${#tables[@]}" '$2!="0"{exit 1}END{if(NR!=n)exit 1}' <<< "$out"
to_hold=(); from_hold=(); drops=()
for t in "${tables[@]}"; do
  grep -q "^$t " "$backup/restore-checksums"
  [[ $(s "SELECT COUNT(*) FROM information_schema.triggers WHERE event_object_schema=DATABASE() AND event_object_table NOT IN ($quoted) AND REGEXP_LIKE(action_statement,'(^|[^a-z0-9_])${t}([^a-z0-9_]|$)','i')") == 0 ]]
  to_hold+=("\`$t\` TO \`ret26_$t\`"); from_hold+=("\`ret26_$t\` TO \`$t\`"); drops+=("\`ret26_$t\`")
done
join(){ local IFS=,; echo "$*"; }
s "SET SESSION lock_wait_timeout=8; RENAME TABLE $(join "${to_hold[@]}")"
restore(){ s "SET SESSION lock_wait_timeout=8; RENAME TABLE $(join "${from_hold[@]}")"; }
trap restore ERR
for t in "${tables[@]}"; do
  before=$(awk -v n="$t" '$1==n{print $2}' "$backup/restore-checksums")
  now=$(s "CHECKSUM TABLE \`ret26_$t\` EXTENDED" | awk '{print $2}')
  test "$now" = "$before"
done
export PATH="$HOME/.nvm/versions/node/v22.14.0/bin:$PATH"
node "$d/validate-api.cjs" --api-only
s "SET SESSION FOREIGN_KEY_CHECKS=0; DROP TABLE $(join "${drops[@]}")"
trap - ERR
echo "Retired ${#tables[@]} reconciled tables in $db"
