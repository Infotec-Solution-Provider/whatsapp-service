import assert from "node:assert/strict";
import { test } from "node:test";

const saved=new Map<string,NodeModule|undefined>();
function stub(path:string,value:unknown){const file=require.resolve(path);saved.set(file,require.cache[file]);require.cache[file]={id:file,filename:file,loaded:true,exports:{__esModule:true,default:value}} as NodeModule;}
let changed=false,failMessage=false,writes=0,notified=0,uniqueReads=0;
const original={id:9,instance:"a",contactId:1,userId:7,sectorId:4,isFinished:false};let chat={...original};
const matches=(where:any)=>Object.entries(where).every(([key,value])=>(chat as any)[key]===value);
const database={wppChat:{
 findFirst:async({where}:any)=>matches(where)?{...chat}:null,
 findUnique:async()=>{uniqueReads++;return {...chat,contact:null};},
 updateMany:async({where,data}:any)=>{if(changed)chat.userId=8;if(!matches(where))return{count:0};writes++;Object.assign(chat,data);return{count:1};}
}};
stub("./prisma.service",database);stub("./instances.service",{executeQuery:async()=>[]});
stub("../utils/processing-logger",class {log(){}success(){}failed(){}});
stub("./socket.service",{emit:async()=>undefined});stub("./messages-distribution.service",{addSystemMessage:async()=>{if(failMessage)throw new Error("fixture delivery failure");notified++;}});
stub("./users.service",()=>({setAuth:()=>undefined}));
for(const path of ["../bots/exatron-satisfaction.bot","./transfer-history.service","./whatsapp.service","./parameters.service","./contacts.service","./message-presentation.service","./chat-user-preferences.service","./public-report-fields.service"])stub(path,{});
const registry=require.resolve("../tenant-sql/registry");saved.set(registry,require.cache[registry]);require.cache[registry]={id:registry,filename:registry,loaded:true,exports:{tenantSqlEnabled:()=>true}} as NodeModule;
const service=(require("./chats.service") as typeof import("./chats.service")).default;
for(const[file,previous]of saved){if(previous)require.cache[file]=previous;else delete require.cache[file];}
const expected={instance:"a",contactId:1,userId:7,sectorId:4};
test("scheduled finish preserves expected ownership in its actual UPDATE",async()=>{chat={...original};changed=false;failMessage=false;writes=0;notified=0;await service.systemFinishChatById(9,"fixture",expected);assert.equal(writes,1);assert.equal(notified,1);assert.equal(chat.isFinished,true)});
test("ownership transfer after the read prevents closing or notifying the new owner's chat",async()=>{chat={...original};changed=true;writes=0;notified=0;await assert.rejects(()=>service.systemFinishChatById(9,"fixture",expected),(e:any)=>(e.status??e.statusCode)===409);assert.equal(writes,0);assert.equal(notified,0);assert.equal(chat.isFinished,false);assert.equal(chat.userId,8)});
test("a stale expected sector is rejected before writes",async()=>{chat={...original,sectorId:3};changed=false;writes=0;await assert.rejects(()=>service.systemFinishChatById(9,"fixture",expected));assert.equal(writes,0)});
test("legacy system finish retains its unique lookup when no schedule precondition was provided",async()=>{chat={...original};changed=false;uniqueReads=0;await service.systemFinishChatById(9,"fixture");assert.equal(uniqueReads,2);assert.equal(chat.isFinished,true);});
