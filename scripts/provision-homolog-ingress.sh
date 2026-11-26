#!/usr/bin/env bash
set -euo pipefail
root=/home/inpulse/htdocs/homolog
hsql="$root/bin/hsql.sh"
dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
central=homolog-whatsapp
[[ $("$hsql" "$central" -NB -e "SELECT CONCAT(SUBSTRING_INDEX(CURRENT_USER(),'@',1),':',DATABASE())") == homolog:homolog-whatsapp ]]
"$hsql" "$central" < "$dir/homolog-central-ingress.sql"
for tenant in infotec suprimaxxi; do
  case $tenant in
    infotec) db=homolog-infotec-whatsapp-runtime ;;
    suprimaxxi) db=homolog-crm-suprimaxxi ;;
  esac
  "$hsql" "$db" -e 'CREATE TABLE IF NOT EXISTS wpp_runtime_waba_reaction_operations LIKE `homolog-whatsapp`.waba_reaction_operations'
  for op in INSERT UPDATE DELETE; do
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
