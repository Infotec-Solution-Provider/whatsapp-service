import crypto from 'node:crypto';
import {preparePrivateOutput,privateWrite} from 'file:///C:/Workspace/infotec/planejamento/cross-service/INF-20261109-001-odim-migracao-producao/integration/production-db-preparation/writer-crm-reviewed-v4.mjs';
const a=process.argv.slice(2),out=a[a.indexOf('--out')+1];
if(!a.includes('--prepare-user-authorized-test')||!a.includes('--out')||!a.includes('--recipient')||!/^\d{10,15}$/.test(a[a.indexOf('--recipient')+1]||''))throw Error('EXPLICIT_TEST_ACK_REQUIRED');
await preparePrivateOutput(out);
const config={version:1,enabled:true,instance:'odim',recipient:a[a.indexOf('--recipient')+1],clientId:13,contactId:84635,chatId:349572,userId:6,traceId:crypto.randomUUID(),text:"Teste autorizado do in.pulse novo da Odim. Código ODIM-1011-P1. Responda 'Recebido P1' para validar o retorno.",expiresAt:new Date(Date.now()+3600000).toISOString()};
await privateWrite(out,'odim-pilot-send.json',config);
await privateWrite(out,'setup-receipt.json',{purpose:'User explicitly authorized real application send/receive test to own number',actor:6,clientId:13,contactId:84635,chatId:349572,traceId:config.traceId,expiresAt:config.expiresAt,maximumProviderDispatches:1,globalProviderBootstrap:false,cutover:false});
console.log(JSON.stringify({prepared:true,traceId:config.traceId,expiresAt:config.expiresAt,oneFixedNumber:true,maximumDispatches:1,cutover:false}));
