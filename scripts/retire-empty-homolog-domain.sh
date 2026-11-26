#!/usr/bin/env bash
# Retire only empty legacy tables. FKs, triggers, recovery copy and the live registry are checked before the atomic rename.
set -euo pipefail
umask 077
root=/home/inpulse/htdocs/homolog
hsql="$root/bin/hsql.sh"
backup=${1:?Verified backup directory required}
[[ "$backup" == "$root"/backups/whatsapp-residency.* && -s "$backup/restore-checksums" ]]
(cd "$backup" && sha256sum --quiet --check SHA256SUMS)
db=homolog-whatsapp
tables=(_WppChatToWppTag automatic_response_rule_users automatic_response_rules automatic_response_schedules chat_user_preferences contact_action_requests internal_chat_members internal_mentions internal_message_processing_queue internal_whatsapp_senders internalchats internalmessages message_flow_metrics message_flow_versions message_queue_items notifications pipeline_enrollment_outbox ready_messages tags waba_reaction_operations wallets_users)
s(){ "$hsql" "$db" -NB -e "$1"; }
[[ $(s "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
curl -fsS http://127.0.0.1:7105/health | grep -q '"storage":"tenant-sql"'
[[ -e "$root/whatsapp/homolog-central-ingress.enabled" ]]
quoted=$(printf "'%s'," "${tables[@]}"); quoted=${quoted%,}
[[ $(s "SELECT COUNT(*) FROM information_schema.key_column_usage WHERE referenced_table_schema=DATABASE() AND referenced_table_name IN ($quoted) AND (table_schema<>DATABASE() OR table_name NOT IN ($quoted))") == 0 ]]
[[ $(s "SELECT COUNT(*) FROM information_schema.view_table_usage WHERE table_schema=DATABASE() AND table_name IN ($quoted)") == 0 ]]
to_hold=(); from_hold=(); drops=()
for t in "${tables[@]}"; do
  grep -q "^$t " "$backup/restore-checksums"
  [[ $(s "SELECT COUNT(*) FROM information_schema.triggers WHERE event_object_schema=DATABASE() AND event_object_table NOT IN ($quoted) AND REGEXP_LIKE(action_statement,'(^|[^a-z0-9_])${t}([^a-z0-9_]|$)','i')") == 0 ]]
  for target in homolog-infotec-whatsapp-runtime homolog-crm-suprimaxxi; do
    [[ $(s "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$target' AND table_name='wpp_runtime_$t'") == 1 ]]
  done
  [[ $(s "SELECT EXISTS(SELECT 1 FROM \`$t\` LIMIT 1)") == 0 ]]
  to_hold+=("\`$t\` TO \`ret26_$t\`"); from_hold+=("\`ret26_$t\` TO \`$t\`"); drops+=("\`ret26_$t\`")
done
join(){ local IFS=,; echo "$*"; }
s "SET SESSION lock_wait_timeout=5; RENAME TABLE $(join "${to_hold[@]}")"
# A write racing preflight is captured by the renamed table. Restore every name if any row appeared.
for t in "${tables[@]}"; do
  if [[ $(s "SELECT EXISTS(SELECT 1 FROM \`ret26_$t\` LIMIT 1)") != 0 ]]; then
    s "RENAME TABLE $(join "${from_hold[@]}")"; exit 1
  fi
done
s "SET SESSION FOREIGN_KEY_CHECKS=0; DROP TABLE $(join "${drops[@]}")"
echo "Retired ${#tables[@]} empty tables in $db"
