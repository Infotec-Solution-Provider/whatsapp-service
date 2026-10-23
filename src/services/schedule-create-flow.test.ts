import assert from "node:assert/strict";
import { test } from "node:test";
const saved=new Map<string,NodeModule|undefined>();
function stub(path:string,value:unknown){const file=require.resolve(path);saved.set(file,require.cache[file]);require.cache[file]={id:file,filename:file,loaded:true,exports:{__esModule:true,default:value}} as NodeModule;}
let creationFails=false,finishFails=false,hasChat=true,created=0,finishes=0,scope:unknown;
const schedule={id:101,scheduleDate:new Date("2099-02-01T12:00:00Z")};
stub("./schedule-creation.service",{create:async()=>{if(creationFails)throw new Error("validation failed");created++;return{schedule,chat:hasChat?{id:9,instance:"a",contactId:1,userId:7,sectorId:4}:null}}});
stub("./chats.service",{systemFinishChatById:async(_id:number,_reason:string,expected:unknown)=>{finishes++;scope=expected;if(finishFails)throw new Error("changed ownership");}});
for(const path of ["./prisma.service","./instances.service","./local-sync.service"])stub(path,{});
stub("node-cron",{schedule:()=>undefined});stub("../routines/idle-chats.routine",()=>undefined);stub("../routines/schedules.routine",()=>undefined);
const registry=require.resolve("../tenant-sql/registry");saved.set(registry,require.cache[registry]);require.cache[registry]={id:registry,filename:registry,loaded:true,exports:{tenantSqlEnabled:()=>true}} as NodeModule;
const service=(require("./schedules.service") as typeof import("./schedules.service")).default;
for(const[file,previous]of saved){if(previous)require.cache[file]=previous;else delete require.cache[file];}
const actor={instance:"a",userId:7,sectorId:3,role:"ATIVO",name:"Fixture"};
test("validated schedule closes only its original chat identity",async()=>{creationFails=false;finishFails=false;hasChat=true;created=0;finishes=0;assert.equal(await service.createSchedule(actor,{} as any),schedule);assert.equal(created,1);assert.equal(finishes,1);assert.deepEqual(scope,{instance:"a",contactId:1,userId:7,sectorId:4});});
test("invalid schedule does not attempt any chat closure",async()=>{creationFails=true;created=0;finishes=0;await assert.rejects(()=>service.createSchedule(actor,{} as any));assert.equal(created,0);assert.equal(finishes,0);});
test("failure after schedule insertion explicitly reports partial confirmation without retry",async()=>{creationFails=false;finishFails=true;created=0;finishes=0;await assert.rejects(()=>service.createSchedule(actor,{} as any),/Agendamento criado.*Atualize a lista/);assert.equal(created,1);assert.equal(finishes,1);});
test("scheduling without an open chat has no closure side effect",async()=>{creationFails=false;hasChat=false;finishes=0;assert.equal(await service.createSchedule(actor,{} as any),schedule);assert.equal(finishes,0);});
