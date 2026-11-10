import test from 'node:test';
import assert from 'node:assert/strict';
import {priority,messageTime,status} from './odim-operational-copy.mjs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
test('explicit legacy priority precedence, agreed MEDIA/empty and Unix dates',()=>{
 assert.equal(priority({URGENCIA_SUPERVISOR:'NORMAL',URGENCIA_OPERADOR:'URGENTE'}),'NORMAL');
 assert.equal(priority({URGENCIA_SUPERVISOR:'',URGENCIA_AGENDAMENTO:'MEDIA',URGENCIA_OPERADOR:'ALTA'}),'NORMAL');
 assert.equal(priority({}),'NORMAL');assert.equal(priority({URGENCIA_OPERADOR:'MUITO_ALTA'}),'VERY_HIGH');
 assert.deepEqual(messageTime({TIMESTAMP:1794326400000}),messageTime({TIMESTAMP:'1794326400'}));assert.equal(messageTime({TIMESTAMP:1794326400123}).timestamp,'1794326400123');assert.equal(status('UNKNOWN_4'),'UNKNOWN');assert.equal(status('PLAYED'),'READ');
});
test('actual MySQL reserved IDs support newest-first loading alongside independent auto writers',async()=>{
 const schema='odim_copy_fixture_'+crypto.randomBytes(5).toString('hex');const sql=s=>{const r=spawnSync('docker',['exec','-i','homolog-odim-mysql8-20261109','mysql','-uroot','--batch'],{input:s,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr)};
 sql(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4;USE ${schema};CREATE TABLE messages(id INT PRIMARY KEY AUTO_INCREMENT,instance VARCHAR(191),body LONGTEXT,sent_at DATETIME,user_id INT,quoted_id INT) ENGINE=InnoDB;`);
 const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:'127.0.0.1',port:13318,user:'root',database:schema,dateStrings:true,timezone:'Z'});
 try{
  await db.query('ALTER TABLE messages AUTO_INCREMENT=101');
  await db.query("INSERT INTO messages(id,instance,body,user_id,quoted_id) VALUES(100,'odim','Recente 💚',-2,98)");
  await db.query("INSERT INTO messages(instance,body) VALUES('foreign','independent writer')");
  await db.query("INSERT INTO messages(id,instance,body,user_id) VALUES(99,'odim','Anterior',-1),(98,'odim','Mais antiga',510)");
  const [rows]=await db.query("SELECT id,body,user_id,quoted_id FROM messages WHERE instance='odim' ORDER BY id DESC");assert.deepEqual(rows.map(r=>r.id),[100,99,98]);assert.equal(rows[0].body,'Recente 💚');assert.equal(rows[0].user_id,-2);assert.equal(rows[0].quoted_id,98);
  await db.beginTransaction();await assert.rejects(db.query("INSERT INTO messages(id,instance,body) VALUES(99,'odim','must not overwrite')"));await db.rollback();const [[original]]=await db.query('SELECT body FROM messages WHERE id=99');assert.equal(original.body,'Anterior');
 }finally{await db.end();sql(`DROP DATABASE ${schema}`)}
});
