const assert=require('node:assert/strict');
const fixture=require('./monitor-homolog-qa.cjs').createFixture('search');
const {schema,sql}=fixture;
let real,created=false,cases=0,queries=[];
const quote=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/\\/g,'\\\\').replace(/'/g,"''")+"'";
const insert=(table,row)=>`INSERT INTO ${table} (${Object.keys(row).map(key=>'`'+key+'`').join(',')}) VALUES (${Object.values(row).map(quote).join(',')});`;
const now=Date.parse('2026-11-10T18:00:00.000Z');
const at=minutes=>new Date(now+minutes*60000).toISOString().slice(0,23).replace('T',' ');
const stamp=minutes=>String(now+minutes*60000);
const stub=(relative,value)=>{const id=require.resolve(relative);require.cache[id]={id,filename:id,loaded:true,exports:{__esModule:true,default:value}};};

async function main(){
 sql(`CREATE DATABASE ${schema} CHARACTER SET utf8mb4;`);created=true;
 let setup=`USE ${schema};
 CREATE TABLE contacts(id INT PRIMARY KEY,instance VARCHAR(191),name VARCHAR(191),phone VARCHAR(191),customer_id INT);
 CREATE TABLE chats(id INT PRIMARY KEY,instance VARCHAR(191),contact_id INT,user_id INT,sector_id INT,bot_id INT,type VARCHAR(30),avatar_url TEXT,is_finished TINYINT,is_schedule TINYINT,started_at DATETIME(3),finished_at DATETIME(3),finished_by INT,result_id INT,INDEX chats_instance_is_finished_finished_at_idx(instance,is_finished,finished_at));
 CREATE TABLE messages(id INT PRIMARY KEY,instance VARCHAR(191),chat_id INT,contact_id INT,\`from\` VARCHAR(191),\`to\` VARCHAR(191),body TEXT,type VARCHAR(30),timestamp VARCHAR(30),sent_at DATETIME(3),status VARCHAR(30),client_id INT,INDEX messages_chat_id_fkey(chat_id),INDEX messages_instance_chat_id_sent_at_id_idx(instance,chat_id,sent_at,id));
 CREATE TABLE schedules(id INT PRIMARY KEY,instance VARCHAR(191),chat_id INT,contact_id INT,description TEXT,scheduled_at DATETIME(3),schedule_date DATETIME(3),scheduled_by INT,scheduled_for INT,sector_id INT);
 CREATE TABLE internalchats(id INT PRIMARY KEY,instance VARCHAR(191),user_id INT,sector_id INT,is_finished TINYINT,started_at DATETIME(3),finished_at DATETIME(3),finished_by INT,is_group TINYINT,group_name VARCHAR(191),group_description TEXT,group_image_file_id INT,wpp_group_id VARCHAR(191));
 CREATE TABLE internalmessages(id INT PRIMARY KEY,instance VARCHAR(191),internalchat_id INT,\`from\` VARCHAR(191),type VARCHAR(30),body TEXT,timestamp VARCHAR(30),status VARCHAR(30),client_id INT);
 CREATE TABLE internal_chat_members(internalchatId INT,internalcontactId INT,joined_at DATETIME(3),last_read_at DATETIME(3));`;
 for(const row of [{id:1,instance:'odim',name:'Alpha',phone:'5544999990000',customer_id:100},{id:2,instance:'odim',name:'Beta',phone:'5511999990000',customer_id:200},{id:3,instance:'foreign',name:'Alpha',phone:'5544999990000',customer_id:100}])setup+=insert('contacts',row);
 const chat=(id,extra={})=>insert('chats',{id,instance:'odim',contact_id:1,user_id:9,sector_id:138,bot_id:null,type:'DEFAULT',avatar_url:null,is_finished:0,is_schedule:0,started_at:at(-120),finished_at:null,finished_by:null,result_id:null,...extra});
 for(const id of [1,2,3,4,5,6,7,8,9,10,12,13])setup+=chat(id,{contact_id:id===2||id===7?2:1,user_id:id===4?null:id===13?534:9,bot_id:id===5?88:null,is_finished:[8,9,10].includes(id)?1:0,is_schedule:id===1?1:0,started_at:id===10?null:at(id===3||id===4?-1:-120),finished_at:[8,9].includes(id)?at(-5):null});
 setup+=chat(14,{instance:'foreign',contact_id:3});
 let messageId=100;
 const message=(chatId,from,minutes,status='RECEIVED',channel=13,body='LATEST '+chatId,extra={})=>insert('messages',{id:messageId++,instance:'odim',chat_id:chatId,contact_id:[2,7].includes(chatId)?2:1,from,to:'fixture',body,type:'chat',timestamp:stamp(minutes),sent_at:at(minutes),status,client_id:channel,...extra});
 setup+=message(1,'fixture-inbound',-60)+message(2,'user:9',-20,'SENT')+message(3,'fixture-inbound',-2)+message(5,'fixture-inbound',-5);
 setup+=message(6,'fixture-inbound',-60)+message(6,'user:9',-1,'UNKNOWN',14,'FAILED_LATEST')+message(6,'system:notice',0,'SENT',14,'SYSTEM_LATEST');
 setup+=message(7,'fixture-inbound',-20,'RECEIVED',13,'OLD_ONLY_MARKER')+message(7,'user:9',-10,'SENT',13)+message(7,'bot:99',-5,'SENT',14,'BOT_LATEST');
 setup+=message(8,'fixture-inbound',-30)+message(9,'user:9',-10,'SENT',13)+message(9,'fixture-inbound',-10,'READ',14,'TIE_HIGHER_ID');
 setup+=message(12,'',-10,'RECEIVED',13,'EMPTY_SENDER')+message(12,'thirdparty:fixture',-1,'SENT',14,'THIRD_PARTY_LATEST');
 setup+=message(13,'fixture-inbound',-10)+message(14,'fixture-inbound',-60,'RECEIVED',13,'FOREIGN',{instance:'foreign',contact_id:3});
 setup+=message(2,'fixture-inbound',1,'RECEIVED',14,'NULL_SENT',{id:99999,sent_at:null});
 for(let id=20;id<55;id++){
  setup+=chat(id,{contact_id:id%2?1:2,user_id:id%2?9:534,is_finished:1,started_at:at(-id*10),finished_at:at(-id*9)});
  setup+=message(id,'fixture-inbound',-id*9,[21,32].includes(id)?'RECEIVED':'READ',id%2?13:14);
 }
 for(const row of [{id:1,chat_id:null,schedule_date:at(60)},{id:2,chat_id:null,schedule_date:at(72*60)},{id:3,chat_id:null,schedule_date:at(-30)},{id:4,chat_id:1,schedule_date:at(30)}])setup+=insert('schedules',{...row,instance:'odim',contact_id:1,description:'Schedule LATEST '+row.id,scheduled_at:at(-60),scheduled_by:9,scheduled_for:534,sector_id:138});
 setup+=insert('schedules',{id:99,instance:'foreign',chat_id:null,contact_id:3,description:'FOREIGN',scheduled_at:at(-60),schedule_date:at(30),scheduled_by:9,scheduled_for:534,sector_id:138});
 for(const id of [1,2,3,99]){
  setup+=insert('internalchats',{id,instance:id===99?'foreign':'odim',user_id:9,sector_id:138,is_finished:id===3?1:0,started_at:at(-120),finished_at:id===3?at(-5):null,finished_by:null,is_group:id===2?0:1,group_name:id===1?'Alpha':'Internal '+id,group_description:null,group_image_file_id:null,wpp_group_id:null});
  setup+=insert('internal_chat_members',{internalchatId:id,internalcontactId:9,joined_at:at(-120),last_read_at:at(-30)});
  setup+=insert('internalmessages',{id,instance:id===99?'foreign':'odim',internalchat_id:id,from:id===2?'user:9':'user:32',body:'Internal LATEST '+id,type:'chat',timestamp:stamp(-10),status:'READ',client_id:13});
 }
 sql(setup);
 const {PrismaClient}=require('@prisma/client');real=new PrismaClient({datasources:{db:{url:fixture.url}}});
 // Run the new source without rebuilding the nine already frozen runtime files.
 require('ts-node/register/transpile-only');
 stub('../src/services/prisma.service.ts',{});stub('../src/services/parameters.service.ts',{});stub('../src/services/instances.service.ts',{});
 const {parseMonitorRequest}=require('../src/services/monitor/monitor-contract.ts');
 const {buildMonitorQuery,monitorOrder}=require('../src/services/monitor/monitor-query.ts');
 const {readOptimizedCentralMonitorSearch:readOdimModernMonitorSearch,buildOptimizedClosedSearch:buildOdimClosedSearch}=require('../src/services/monitor/optimized-search.ts');
 const {mapMonitorRow}=require('../src/services/monitor/monitor-reader.ts');
 const {readOptimizedCentralMonitorSummary}=require('../src/services/monitor/optimized-summary.ts');
 assert.equal(typeof buildOdimClosedSearch,'function');
 const execute=async(query,...values)=>{assert.match(query,/^SELECT/);assert(!/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP)\b/i.test(query));assert.match(query,/MAX_EXECUTION_TIME\((5000|10000)\)/);if(query.includes('MAX_EXECUTION_TIME(10000)'))assert.match(query,/unread_chat_ids|archive_monitor_page|AS unread FROM chats c/);if(query.includes('archive_monitor_page'))assert.match(query,/closed_candidates/);queries.push({query,values});return real.$queryRawUnsafe(query,...values);};
 const session={instance:'odim',role:'ADMIN',userId:9,sectorId:138};
 const oracle=async(context,request)=>{
  const f=context.filters,parts=[];
  if(f.categories.showCustomerChats)parts.push(buildMonitorQuery('wpp',context));
  if(f.categories.showInternalChats||f.categories.showInternalGroups)parts.push(buildMonitorQuery('internal',context));
  if(f.categories.showSchedules)parts.push(buildMonitorQuery('schedule',context));
  if(!parts.length)return{rows:[],totalCount:0,page:request.page,pageSize:request.pageSize};
  const union=parts.map(part=>'('+part.sql+')').join(' UNION ALL '),values=parts.flatMap(part=>part.params),order=monitorOrder(f);
  // Production has no UNIQUE(chat_id) on schedules. Canonicalize only after applying the original matching filters.
  const canonical='SELECT * FROM (SELECT matching.*,ROW_NUMBER() OVER(PARTITION BY category,id ORDER BY scheduled_at DESC,schedule_id DESC) AS oracle_rank FROM ('+union+') matching) ranked WHERE oracle_rank=1';
  const [count]=await real.$queryRawUnsafe('SELECT COUNT(*) AS total FROM ('+canonical+') all_rows',...values);
  const rows=await real.$queryRawUnsafe('SELECT all_rows.*,'+order.projection+' FROM ('+canonical+') all_rows ORDER BY '+order.order+' LIMIT ? OFFSET ?',...values,request.pageSize,(request.page-1)*request.pageSize);
  return{rows,totalCount:Number(count.total),page:request.page,pageSize:request.pageSize};
 };
 const numeric=value=>value==null?null:Number(value);
 const summaryOracle=async(context)=>{
  const current={...context,filters:{...context.filters,operationalStatus:'all'}},f=current.filters,result={inProgress:0,waitingAgent:0,waitingCustomer:0,unread:0,overdue:0,scheduled:0,slaMinutes:context.slaMinutes};
  for(const category of [...(f.categories.showCustomerChats?['wpp']:[]),...(f.categories.showInternalChats||f.categories.showInternalGroups?['internal']:[]),...(f.categories.showSchedules?['schedule']:[])]){
   const source=buildMonitorQuery(category,current);
   const dedup="SELECT * FROM (SELECT legacy.*,ROW_NUMBER() OVER(PARTITION BY category,id ORDER BY scheduled_at DESC,schedule_id DESC) rn FROM ("+source.sql+") legacy) ranked WHERE rn=1";
   const [row]=await real.$queryRawUnsafe("SELECT SUM(operational_status IN ('in_progress','waiting_agent','waiting_customer')) AS inProgress,SUM(operational_status='waiting_agent') AS waitingAgent,SUM(operational_status='waiting_customer') AS waitingCustomer,SUM(unread_count>0) AS unread,SUM(sla_breached=1) AS overdue,SUM(upcoming=1) AS scheduled FROM ("+dedup+") summary_reference",...source.params);
   for(const key of ['inProgress','waitingAgent','waitingCustomer','unread','overdue','scheduled'])result[key]+=Number(row?.[key]??0);
  }
  return result;
 };
 const projection=row=>{
  const result={};for(const key of ['category','operational_status','lm_body','lm_from','lm_status','outgoing_status'])result[key]=row[key]??null;
  for(const key of ['id','user_id','bot_id','contact_id','is_finished','is_schedule','is_group','lm_id','lm_at','lm_client_id','waiting_since','unread_count','sla_breached','upcoming','outgoing_id','schedule_id','schedule_date','started_at','finished_at'])result[key]=numeric(row[key]);
  return result;
 };
 async function check(input={},slaMinutes=30,customerIds=[]){
  const request=parseMonitorRequest(input),context={session,local:false,slaMinutes,now:new Date(now),customerIds,filters:request.filters};
  const expected=await oracle(context,request),actual=await readOdimModernMonitorSearch(context,request,execute);
  assert.equal(actual.totalCount,expected.totalCount,'count '+JSON.stringify(input));assert.equal(actual.page,request.page);assert.equal(actual.pageSize,request.pageSize);
  assert.deepEqual(actual.rows.map(row=>row.category+':'+row.id),expected.rows.map(row=>row.category+':'+row.id),'global order/page '+JSON.stringify(input));
  assert.deepEqual(actual.rows.map(projection),expected.rows.map(projection),'hydrated facts '+JSON.stringify(input));
  assert(actual.rows.every(row=>row.instance===session.instance));
  assert.deepEqual(await readOptimizedCentralMonitorSummary(context,execute),await summaryOracle(context),'summary '+JSON.stringify(input));
  cases++;return actual;
 }
 for(const page of [1,2,3,4,5,8,10,11,20])await check({page,pageSize:5});
 for(const sortBy of ['urgency','name','startedAt','finishedAt','lastMessage','scheduledAt'])for(const sortOrder of ['asc','desc'])for(const page of [1,3,8])await check({page,pageSize:5,filters:{sortBy,sortOrder}});
 for(const operationalStatus of ['all','in_progress','waiting_agent','waiting_customer','unread','overdue','scheduled'])for(const page of [1,2])await check({page,pageSize:3,filters:{operationalStatus}});
 const categories=(showCustomerChats,showInternalChats,showInternalGroups,showSchedules)=>({showCustomerChats,showInternalChats,showInternalGroups,showSchedules});
 for(const filters of [{showOngoing:false},{showFinished:false},{showOngoing:false,showFinished:false},{showBots:true},{showOnlyScheduled:true},{showUnreadOnly:true},{showPendingResponseOnly:true},{user:9},{user:534},{lastMessageChannelId:13},{lastMessageChannelId:14},{lastMessageChannelId:999},{categories:categories(true,false,false,false)},{categories:categories(false,true,false,false)},{categories:categories(false,false,true,false)},{categories:categories(false,false,false,true)},{categories:categories(false,false,false,false)},{searchText:'Alpha',searchColumn:'name'},{searchText:'+55 (44)',searchColumn:'phone'},{searchText:'OLD_ONLY_MARKER',searchColumn:'message'},{searchText:'BOT_LATEST',searchColumn:'message'},{searchText:'LATEST',searchColumn:'all'},{startedAt:{from:new Date(now-10*60000).toISOString()}},{finishedAt:{to:new Date(now-30*60000).toISOString()}},{scheduledAt:{from:new Date(now-120*60000).toISOString(),to:new Date(now).toISOString()}},{scheduledTo:{from:new Date(now).toISOString(),to:new Date(now+120*60000).toISOString()}},{scheduledBy:9},{scheduledFor:534}])await check({pageSize:100,filters});
 for(const page of [1,2,3,4])await check({page,pageSize:1,filters:{sortBy:'name',sortOrder:'asc'}});
 await check({pageSize:100,filters:{searchText:'CRM fixture',searchColumn:'customer'}},30,[100]);
 const attack="%' OR 1=1 --_=";const attacked=await check({pageSize:100,filters:{searchText:attack,searchColumn:'all'}});assert.equal(attacked.totalCount,0);assert(queries.every(call=>!call.query.includes(attack)));assert(queries.some(call=>call.values.includes("%=%' OR 1==1 --=_==%")));
 for(const sla of [null,30])for(let repeat=0;repeat<2;repeat++)await check({page:4,pageSize:7,filters:{sortBy:'urgency',sortOrder:'desc'}},sla);
 const all=await check({pageSize:100});
 const failed=all.rows.find(row=>row.category==='wpp'&&row.id===6);assert(failed);const mapped=mapMonitorRow(failed);assert.equal(mapped.operational.status,'waiting_agent');assert.equal(mapped.operational.deliveryStatus,'UNKNOWN');assert.equal(mapped.operational.lastMessagePreview,'SYSTEM_LATEST');assert.equal(mapped.operational.slaBreached,true);
 const botLatest=all.rows.find(row=>row.category==='wpp'&&row.id===7);assert.equal(botLatest.operational_status,'waiting_customer');assert.equal(botLatest.lm_client_id,14);assert.equal(botLatest.lm_body,'BOT_LATEST');
 const nullDate=all.rows.find(row=>row.category==='wpp'&&row.id===10);assert.equal(nullDate.lm_id,null);assert.equal(nullDate.started_at,null);
 assert(all.rows.some(row=>row.category==='wpp'&&row.id===1)&&all.rows.some(row=>row.category==='internal'&&row.id===1)&&all.rows.some(row=>row.category==='schedule'&&row.id===1));
 sql(`USE ${schema};`+insert('schedules',{id:5,instance:'odim',chat_id:1,contact_id:1,description:'Latest matching 534',scheduled_at:at(-1),schedule_date:at(120),scheduled_by:9,scheduled_for:534,sector_id:138})+insert('schedules',{id:6,instance:'odim',chat_id:1,contact_id:1,description:'Latest matching 32',scheduled_at:at(0),schedule_date:at(180),scheduled_by:32,scheduled_for:32,sector_id:138}));
 for(const filters of [{},{scheduledFor:534},{scheduledBy:9},{sortBy:'scheduledAt',sortOrder:'desc'},{showOnlyScheduled:true}]){
  const result=await check({pageSize:100,filters});assert.equal(result.rows.filter(row=>row.category==='wpp'&&row.id===1).length,1,'Duplicate linked schedules must not duplicate the conversation');
 }
 session.instance='infotec';session.sectorId=1;
 assert.equal((await check({pageSize:100})).totalCount,0,'Fresh Infotec must not see populated Odim/foreign fixtures');
 sql(`USE ${schema};`+['contacts','chats','messages','schedules','internalchats','internalmessages'].map(table=>`UPDATE ${table} SET instance='infotec' WHERE instance='odim';`).join(''));
 for(const filters of [{},{sortBy:'lastMessage',sortOrder:'asc'},{operationalStatus:'unread'},{lastMessageChannelId:14},{searchText:'LATEST',searchColumn:'message'}])await check({pageSize:100,filters});
 const request=parseMonitorRequest({});const before=queries.length;
 for(const denied of [{...session,instance:'foreign'},{...session,role:'USER'}])await assert.rejects(readOdimModernMonitorSearch({session:denied,local:false,slaMinutes:30,now:new Date(now),customerIds:[],filters:request.filters},request,execute));
 await assert.rejects(readOdimModernMonitorSearch({session,local:true,slaMinutes:30,now:new Date(now),customerIds:[],filters:request.filters},request,execute));assert.equal(queries.length,before);
 console.log(JSON.stringify({passed:true,actualMysql:true,differentialCases:cases,infotecEmptyAndPopulatedFixtures:true,globalCategoryPagination:true,deepPriorityBoundary:true,allSortsAndDirections:true,latestChannelAndMessageFilters:true,rawFactsEqual:true,preparedReexecution:true,tenantIsolation:true,strictScope:true,injectionBound:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(real)await real.$disconnect();if(created){assert.match(schema,/^odim_monitor_homolog_qa_20261113_search_[0-9a-f]{8}$/);sql(`DROP DATABASE ${schema};`);}});
