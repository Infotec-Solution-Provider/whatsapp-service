#!/usr/bin/env bash
set -euo pipefail
root=/home/inpulse/htdocs/homolog
backup=${1:?Verified backup required}
[[ "$backup" == "$root"/backups/whatsapp-residency.* ]]
(cd "$backup" && sha256sum --quiet --check SHA256SUMS)
h="$root/bin/hsql.sh"
src=homolog-whatsapp
dst=homolog-logs
archive=process_log_metadata_homolog_20261013
old=ret26_process_logs
[[ $("$h" "$src" -NB -e "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
[[ $("$h" "$dst" -NB -e "SELECT EXISTS(SELECT 1 FROM process_logs WHERE created_at>UTC_TIMESTAMP()-INTERVAL 1 DAY LIMIT 1)") == 1 ]]
[[ $("$h" "$src" -NB -e "SELECT COUNT(*) FROM information_schema.key_column_usage WHERE referenced_table_schema=DATABASE() AND referenced_table_name='process_logs'") == 0 ]]
cols="id,instance,process_name,UNHEX(SHA2(process_id,256)) AS process_id_hash,status,start_time,end_time,duration,created_at"
"$h" "$dst" -e "CREATE TABLE $archive (PRIMARY KEY(id)) ENGINE=InnoDB AS SELECT $cols FROM \`$src\`.process_logs WHERE FALSE"
"$h" "$src" -e "SET SESSION lock_wait_timeout=5; RENAME TABLE process_logs TO $old"
restore(){ "$h" "$src" -e "RENAME TABLE $old TO process_logs"; }
trap restore ERR
now=$("$h" "$src" -NB -e "CHECKSUM TABLE $old EXTENDED" | awk '{print $2}')
test "$now" = "$(awk '$1=="process_logs"{print $2}' "$backup/restore-checksums")"
"$h" "$dst" <<SQL
CREATE TEMPORARY TABLE log_metadata_verified(ok INT NOT NULL CHECK(ok=1));
START TRANSACTION;
INSERT INTO $archive SELECT $cols FROM \`$src\`.$old;
INSERT INTO log_metadata_verified SELECT (SELECT COUNT(*) FROM $archive)=8999 AND NOT EXISTS
 (SELECT 1 FROM \`$src\`.$old s LEFT JOIN $archive a ON a.id=s.id WHERE a.id IS NULL OR NOT
 (BINARY a.instance<=>BINARY s.instance AND BINARY a.process_name<=>BINARY s.process_name AND a.process_id_hash<=>UNHEX(SHA2(s.process_id,256))
 AND a.status<=>s.status AND a.start_time<=>s.start_time AND a.end_time<=>s.end_time AND a.duration<=>s.duration AND a.created_at<=>s.created_at));
COMMIT;
SQL
"$h" "$src" -e "DROP TABLE $old"
trap - ERR
echo "8999 metadata records verified in $dst.$archive"
