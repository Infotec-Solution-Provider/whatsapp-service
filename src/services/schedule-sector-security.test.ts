import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionData } from "../sdk-local";

const saved = new Map<string, NodeModule | undefined>();
function stub(path: string, value: unknown) { const file=require.resolve(path);saved.set(file,require.cache[file]);require.cache[file]={id:file,filename:file,loaded:true,exports:{__esModule:true,default:value}} as NodeModule; }
stub("./prisma.service",{});stub("./instances.service",{});
const {ScheduleCreationService}=require("./schedule-creation.service") as typeof import("./schedule-creation.service");
const {SectorClientsService}=require("./sector-clients.service") as typeof import("./sector-clients.service");
for(const [file,previous] of saved){if(previous)require.cache[file]=previous;else delete require.cache[file];}
const actor:SessionData={instance:"a",role:"ATIVO",userId:7,sectorId:3,name:"Fixture"};
const body={contactId:1,sectorId:4,scheduledFor:7,date:"2099-02-01T12:00:00Z",chatId:9};
function fixture(change:Record<string,any>={}){
 const state={contact:{id:1,instance:"a",isDeleted:false,isOnlyAdmin:false},sector:{id:4,instance:"a"},chats:[{id:9,instance:"a",contactId:1,sectorId:4,userId:7,isFinished:false}],users:[{CODIGO:7}],writes:[] as any[],...change};
 const match=(row:any,where:any)=>Object.entries(where).every(([key,value])=>row[key]===value);
 const tx={wppContact:{findFirst:async({where}:any)=>state.contact&&match(state.contact,where)?state.contact:null},wppSector:{findFirst:async({where}:any)=>state.sector&&match(state.sector,where)?state.sector:null},wppChat:{findMany:async({where}:any)=>state.chats.filter((row:any)=>match(row,where))},wppSchedule:{create:async({data}:any)=>{state.writes.push(data);return{id:101,...data}}}};
 const crm={executeQuery:async(instance:string,sql:string,params:unknown[])=>{assert.equal(instance,"a");assert.match(sql,/ATIVO='SIM'/);assert.deepEqual(params,[7]);return state.users}};
 const service=new ScheduleCreationService({$transaction:async(fn:any)=>fn(tx)} as any,crm as any);
 return{state,service};
}
test("schedule preserves the authorized chat sector when the session belongs to another sector",async()=>{const f=fixture();const r=await f.service.create(actor,body);assert.equal(r.schedule.sectorId,4);assert.equal(r.schedule.scheduledBy,7);assert.equal(r.chat?.id,9);assert.equal(f.state.writes.length,1)});
for(const [name,changes,request,status] of [
 ["foreign contact",{contact:{id:1,instance:"b",isDeleted:false}},body,404],
 ["deleted contact",{contact:{id:1,instance:"a",isDeleted:true}},body,404],
 ["restricted contact",{contact:{id:1,instance:"a",isDeleted:false,isOnlyAdmin:true}},body,404],
 ["foreign sector",{sector:{id:4,instance:"b"}},body,404],
 ["inactive/missing recipient",{users:[]},body,400],
 ["foreign owner",{chats:[{id:9,instance:"a",contactId:1,sectorId:4,userId:8,isFinished:false}]},body,403],
 ["mismatched chat sector",{sector:{id:3,instance:"a"}}, {...body,sectorId:3},409],
 ["stale chat identity",{}, {...body,chatId:10},409],
 ["closed explicit chat",{chats:[]},body,409],
 ["ambiguous open chats",{chats:[{id:9,instance:"a",contactId:1,sectorId:4,userId:7,isFinished:false},{id:10,instance:"a",contactId:1,sectorId:4,userId:7,isFinished:false}]},body,409],
 ["foreign session sector without chat",{chats:[]},{contactId:1,sectorId:4,scheduledFor:7,date:body.date},403],
 ["recipient reassignment",{},{...body,scheduledFor:8},403],
 ["privileged field",{},{...body,instance:"b"},400],
 ["invalid calendar date",{},{...body,date:"2099-02-30T12:00:00Z"},400],
 ["missing timezone",{},{...body,date:"2099-02-01T12:00:00"},400]
] as Array<[string,Record<string,any>,unknown,number]>)test("schedule rejects "+name+" before insertion",async()=>{const f=fixture(changes);await assert.rejects(()=>f.service.create(actor,request),(e:any)=>(e.statusCode??e.status)===status);assert.equal(f.state.writes.length,0)});
test("legacy schedule without explicit chat id still requires an unambiguous owned chat",async()=>{const f=fixture(),{chatId,...legacy}=body;assert.equal((await f.service.create(actor,legacy)).schedule.sectorId,4);});
test("operator can schedule without a chat in their own sector",async()=>{const f=fixture({chats:[],sector:{id:3,instance:"a"}});assert.equal((await f.service.create(actor,{contactId:1,sectorId:3,scheduledFor:7,date:body.date})).schedule.sectorId,3)});
test("admin can choose a valid tenant sector without an open chat",async()=>{const f=fixture({chats:[]});assert.equal((await f.service.create({...actor,role:"ADMIN"},{contactId:1,sectorId:4,scheduledFor:7,date:body.date})).schedule.sectorId,4)});
test("sector lookup scopes both sector and channel and selects no provider credentials",async()=>{
 let query:any;const svc=new SectorClientsService({wppSector:{findFirst:async(args:any)=>{query=args;return{clients:[{id:2,name:"Fixture",type:"REMOTE"}]}}}} as any);
 assert.equal((await svc.list(actor,"3")).length,1);assert.deepEqual(query,{where:{id:3,instance:"a"},select:{clients:{where:{instance:"a"},select:{id:true,name:true,type:true}}}});
 await assert.rejects(()=>svc.list(actor,"4"));await svc.list({...actor,role:"ADMIN"},"4");assert.equal(query.where.instance,"a");assert.equal(query.where.id,4);
});
test("authorized zero sector is an empty sentinel without a database read",async()=>{const svc=new SectorClientsService({wppSector:{findFirst:()=>{throw new Error("unexpected read")}}} as any);assert.deepEqual(await svc.list({...actor,sectorId:0},"0"),[]);await assert.rejects(()=>svc.list(actor,"0"));});
for(const id of ["0junk","3junk","-1","1.2","",undefined])test("sector rejects malformed id "+String(id),async()=>{await assert.rejects(()=>new SectorClientsService({} as any).list(actor,id));});
test("absent sector returns a controlled 404",async()=>{const svc=new SectorClientsService({wppSector:{findFirst:async()=>null}} as any);await assert.rejects(()=>svc.list(actor,"3"),(e:any)=>(e.statusCode??e.status)===404)});
