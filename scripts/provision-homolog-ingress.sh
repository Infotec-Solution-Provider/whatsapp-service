#!/usr/bin/env bash
set -euo pipefail
root=/home/inpulse/htdocs/homolog
hsql="$root/bin/hsql.sh"
dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
central=homolog-whatsapp
[[ $("$hsql" "$central" -NB -e "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
ingress="$dir/../prisma/tenant-sql/homolog-central-ingress.sql"
reaction="$dir/../prisma/migrations/20261112190000_waba_reaction_operations/migration.sql"
[[ -f "$ingress" ]] || ingress="$dir/homolog-central-ingress.sql"
[[ -f "$reaction" ]] || reaction="$dir/waba-reaction-migration.sql"
"$hsql" "$central" < "$ingress"
for tenant in infotec suprimaxxi; do
  case $tenant in
    infotec) db=homolog-infotec-whatsapp-runtime ;;
    suprimaxxi) db=homolog-crm-suprimaxxi ;;
  esac
  exists=$("$hsql" "$db" -NB -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='wpp_runtime_waba_reaction_operations'")
  if [[ "$exists" == 0 ]]; then
    sed 's/`waba_reaction_operations`/`wpp_runtime_waba_reaction_operations`/' "$reaction" | "$hsql" "$db"
  fi
  client_type=$("$hsql" "$db" -NB -e "SELECT table_type FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='wpp_runtime_clients'")
  for op in INSERT UPDATE DELETE; do
    if [[ "$client_type" == VIEW ]]; then
      [[ "$tenant" == infotec && $("$hsql" "$db" -NB -e "SELECT COUNT(*) FROM information_schema.view_table_usage WHERE view_schema=DATABASE() AND view_name='wpp_runtime_clients' AND table_schema='crm-sgr-infotec-prod' AND table_name='wpp_hml_clients'") == 1 ]]
      [[ $("$hsql" "$db" -NB -e "SELECT COUNT(*) FROM information_schema.triggers WHERE event_object_schema='crm-sgr-infotec-prod' AND event_object_table='wpp_hml_clients' AND event_manipulation='$op' AND action_statement LIKE '%homolog_ingress_routes%'") == 1 ]]
      continue
    fi
    [[ "$client_type" == 'BASE TABLE' ]]
    name="wpp_hml_ingress_route_${op,,}"
    exists=$("$hsql" "$db" -NB -e "SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND trigger_name='$name'")
    if [[ "$exists" == 1 ]]; then continue; fi
    {
      echo 'DELIMITER $$'
      echo "CREATE TRIGGER $name AFTER $op ON wpp_runtime_clients FOR EACH ROW BEGIN"
      if [[ $op != INSERT ]]; then
        echo "DELETE FROM \`$central\`.homolog_ingress_routes WHERE instance='$tenant' AND client_id=OLD.id;"
      fi
      if [[ $op != DELETE ]]; then
        cat <<SQL
IF NEW.instance='$tenant' AND
 ((NEW.type='REMOTE' AND NULLIF(NEW.remote_client_url,'') IS NOT NULL) OR
  (NEW.type='WABA' AND NULLIF(NEW.waba_phone_id,'') IS NOT NULL) OR
  (NEW.type='GUPSHUP' AND NULLIF(NEW.gupshup_app_id,'') IS NOT NULL)) THEN
 INSERT INTO \`$central\`.homolog_ingress_routes (provider,instance,client_id,route_hash)
 VALUES(NEW.type,NEW.instance,NEW.id,UNHEX(SHA2(CASE NEW.type WHEN 'REMOTE' THEN CAST(NEW.id AS CHAR) WHEN 'WABA' THEN NEW.waba_phone_id ELSE NEW.gupshup_app_id END,256)));
END IF;
SQL
      fi
      echo 'END$$'
      echo 'DELIMITER ;'
    } | "$hsql" "$db"
  done
  "$hsql" "$db" <<SQL
START TRANSACTION;
SELECT id FROM wpp_runtime_clients WHERE instance='$tenant' FOR UPDATE;
DELETE FROM \`$central\`.homolog_ingress_routes WHERE instance='$tenant';
INSERT INTO \`$central\`.homolog_ingress_routes(provider,instance,client_id,route_hash)
SELECT type,instance,id,UNHEX(SHA2(CASE type WHEN 'REMOTE' THEN CAST(id AS CHAR) WHEN 'WABA' THEN waba_phone_id ELSE gupshup_app_id END,256))
FROM wpp_runtime_clients WHERE instance='$tenant' AND
 ((type='REMOTE' AND NULLIF(remote_client_url,'') IS NOT NULL) OR
 (type='WABA' AND NULLIF(waba_phone_id,'') IS NOT NULL) OR
 (type='GUPSHUP' AND NULLIF(gupshup_app_id,'') IS NOT NULL));
COMMIT;
SQL
done
"$hsql" "$central" -e 'SELECT provider,instance,COUNT(*) AS routes FROM homolog_ingress_routes GROUP BY provider,instance'
