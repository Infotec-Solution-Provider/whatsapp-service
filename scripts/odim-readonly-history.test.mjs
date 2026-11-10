import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {indexedRow,validateManifest} from './odim-readonly-history-load.mjs';
test('indexes preserve special actors and civil values without inventing operational links',()=>{
 const row=indexedRow('w_atendimentos',{CODIGO:7,CODIGO_OPERADOR:-2,CODIGO_NUMERO:9,CONCLUIDO:0,DATA_INICIO:'2023-10-09 12:30:00'});
 assert.deepEqual(row,[7,null,9,-2,0,'2023-10-09 12:30:00',null,null]);
 assert.equal(indexedRow('w_clientes_numeros',{CODIGO:-1})[0],-1);
});
test('cutover export, incomplete snapshot and foreign source cannot enter preview',()=>{
 for(const input of [{},{kind:'odim-readonly-consultation-snapshot',state:'IN_PROGRESS'}, {kind:'operational-migration'}])assert.throws(()=>validateManifest(input));
});
test('actual isolated MySQL8 supports exact Unicode hashes, independent IDs and archive constraints',()=>{
 const schema='odim_history_test_'+crypto.randomBytes(5).toString('hex');
 const ddl=fs.readFileSync(new URL('./odim-readonly-history-schema.sql',import.meta.url),'utf8');
 const payload=JSON.stringify({CODIGO:-1,MENSAGEM:'Olá 💚 %20\n<texto>  ',DATA_INICIO:'2023-10-09 00:00:00'}),sha=crypto.createHash('sha256').update(payload).digest('hex'),literal="CONVERT(0x"+Buffer.from(payload).toString('hex')+" USING utf8mb4)";
 const sql=`CREATE DATABASE ${schema} CHARACTER SET utf8mb4; USE ${schema}; ${ddl}
 INSERT INTO legacy_readonly_history_snapshots(id,instance,manifest_sha,source_snapshot_at,manifest) VALUES('00000000-0000-0000-0000-000000000001','odim',REPEAT('a',64),'2026-11-10T00:00:00Z','{}');
 INSERT INTO legacy_readonly_history_rows(snapshot_id,domain,source_id,payload,payload_sha) VALUES('00000000-0000-0000-0000-000000000001','w_mensagens',-1,${literal},'${sha}');
 SELECT IF(payload_sha=SHA2(payload,256) AND JSON_VALID(payload), 'UNICODE_HASH_OK','BAD') FROM legacy_readonly_history_rows;
 SELECT IF(COUNT(*)=0,'STAGED_NOT_VISIBLE','BAD') FROM legacy_readonly_history_snapshots WHERE state='PUBLISHED';
 DROP DATABASE ${schema};`;
 const r=spawnSync('docker',['exec','-i','homolog-odim-mysql8-20261109','mysql','--default-character-set=utf8mb4','-uroot','--batch','--skip-column-names'],{input:sql,encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(r.status,0,'local fixture MySQL command must pass: '+r.stderr);assert.match(r.stdout,/UNICODE_HASH_OK/);assert.match(r.stdout,/STAGED_NOT_VISIBLE/);
});
