// User explicitly requested removal of every temporary Odim migration restriction.
import {createRequire} from 'node:module';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const gate=(b,c)=>{if(!b)throw Error(c)},a=process.argv.slice(2),out=a[a.indexOf('--out')+1];
gate(a.includes('--enable-user-authorized-normal-access')&&a.includes('--out'),'EXPLICIT_AUTHORIZATION_REQUIRED');await preparePrivateOutput(out);
const {loadProdEnv}=await import('file:///C:/Users/rgran/.agents/skills/investigar-producao/scripts/prod-env.mjs'),env=loadProdEnv(),u=new URL(env.PROD_SQL_WHATSAPP_URL);gate(u.hostname==='82.25.64.46'&&u.pathname==='/inpulse-whatsapp'&&!env.PROD_SQL_WHATSAPP_SSH,'TARGET_PIN');
const mysql=createRequire('C:/Users/rgran/.agents/skills/investigar-producao/scripts/package.json')('mysql2/promise'),db=await mysql.createConnection({host:u.hostname,port:3306,user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:'inpulse-whatsapp',multipleStatements:false});
try{
 const [[pin]]=await db.query('SELECT @@hostname host,@@server_uuid uuid');gate(pin.host==='srv733293'&&pin.uuid==='fa36075c-fd89-11ef-b8d7-bc241123d405','IDENTITY_PIN');await db.beginTransaction();
 const [clients]=await db.query("SELECT * FROM clients WHERE instance='odim' FOR UPDATE"),canonical=clients.find(c=>c.id===13),prior=clients.find(c=>c.id===12);gate(clients.length===3&&canonical?.type==='WABA'&&canonical.is_active===0&&canonical.waba_token&&canonical.waba_account_id&&canonical.waba_phone_id,'CANONICAL_CHANNEL_CHANGED');gate(prior&&prior.waba_phone_id===canonical.waba_phone_id&&prior.waba_account_id===canonical.waba_account_id,'DUPLICATE_CHANNEL_IDENTITY_NOT_PROVEN');
 const [[sector]]=await db.query("SELECT id,default_client_id FROM sectors WHERE id=138 AND instance='odim' FOR UPDATE");gate(sector?.default_client_id===13,'SECTOR_CHANGED');
 const [[pending]]=await db.query("SELECT COUNT(*) n FROM waba_webhook_queue WHERE instance='odim' AND status='PENDING'");gate(Number(pending.n)===0,'REVIEW_PENDING_WEBHOOKS_FIRST');
 const [parameters]=await db.query("SELECT * FROM parameters WHERE instance='odim' AND `key`='use_local_contacts_sync' FOR UPDATE");
 await privateWrite(out,'before-and-intent.json',{clients,sector,parameters,operation:'Enable canonical Odim WABA13; remove temporary access-only runtime profile separately; keep central storage, existing flags and authentication',legacyIngressRoutingChanged:false});
 await db.execute("UPDATE clients SET is_active=(id=13) WHERE instance='odim' AND id IN(12,13,14)");
 await db.execute("UPDATE parameters SET value='false' WHERE instance='odim' AND `key`='use_local_contacts_sync' AND value='true'");
 await db.commit();const receipt={normalChannelReady:true,activeClientId:13,duplicateClientsInactive:[12,14],centralContactsStoragePreserved:true,legacyIngressRoutingChanged:false,oldFailedWebhooksReplayed:false,at:new Date().toISOString()};await privateWrite(out,'receipt.json',receipt);console.log(JSON.stringify(receipt));
}catch(e){await db.rollback().catch(()=>{});throw Error('NORMAL_ACCESS_PREPARATION_FAILED_INSPECT_PRIVATE_RECEIPT')}finally{await db.end()}
