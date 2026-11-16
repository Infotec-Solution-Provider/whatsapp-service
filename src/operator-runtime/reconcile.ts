import { createHmac, randomUUID } from "node:crypto";
import { runCentralRuntime, digest } from "./engine";
import type { RuntimeDb, RuntimeRow } from "./core";
import { readRuntimeConfig, readRuntimeKey, type OperatorRuntimeConfig } from "./config";

export interface ReconcileDependencies {
  config?:()=>OperatorRuntimeConfig;
  key?:(profile:OperatorRuntimeConfig)=>Buffer;
  transport?:typeof fetch;
  shouldStop?:()=>boolean;
}
/** Observes CRM proof only. Never replays the legacy writer or any phone INVITE. */
export async function reconcilePhoneFinishes(database:RuntimeDb,dependencies:ReconcileDependencies={}){
  const profile=(dependencies.config??readRuntimeConfig)(),key=(dependencies.key??readRuntimeKey)(profile),transport=dependencies.transport??fetch;
  if(!profile.customersApiUrl)throw Error("OPERATOR_RUNTIME_NOT_CONFIGURED");
  for(const instance of profile.instances){
    if(dependencies.shouldStop?.())return;
    const due=await runCentralRuntime(database,instance,{operation:"operator.runtime",actorId:1,action:"finish.due",input:{}}) as {intents:RuntimeRow[]};
    for(const intent of due.intents){
      if(dependencies.shouldStop?.())return;
      const proof=JSON.parse(String(intent["snapshot_json"])) as RuntimeRow,expected=JSON.parse(String(intent["expected_json"])) as RuntimeRow,actorId=Number(intent["operator_id"]),operationId=String(intent["id"]);
      const requestPath="/api/internal/operator-runtime/finish-proof",body=JSON.stringify({instance,actorId,proof}),timestamp=String(Date.now()),nonce=randomUUID(),signature=createHmac("sha256",key).update(`${timestamp}\n${nonce}\n${requestPath}\n${body}`).digest("hex");
      let observation:RuntimeRow={outcome:"UNKNOWN"};
      try{
        const response=await transport(profile.customersApiUrl.replace(/\/$/,"")+requestPath,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{"Content-Type":"application/json","x-operator-timestamp":timestamp,"x-operator-nonce":nonce,"x-operator-signature":signature},body});
        const raw=await response.text();if(raw.length>65536)throw Error();
        const result=JSON.parse(raw) as {data?:RuntimeRow};
        if(response.ok&&result.data&&["VERIFIED","UNKNOWN"].includes(String(result.data["outcome"])))observation=result.data;
      }catch{/* Preserve uncertainty and schedule another read, never another mutation. */}
      if(dependencies.shouldStop?.())return;
      await runCentralRuntime(database,instance,{operation:"operator.runtime",actorId,action:"finish.verify",input:{operationId,expectedHash:digest(expected["crm"]),proof:{...observation,scheduleId:Number(intent["schedule_id"]),operatorId:actorId}}});
    }
  }
}
export function startOperatorRuntimeReconciliation(database:RuntimeDb,dependencies:ReconcileDependencies={}){
  let busy=false,stopped=false;
  const tick=async()=>{if(busy||stopped)return;busy=true;try{await reconcilePhoneFinishes(database,{...dependencies,shouldStop:()=>stopped||Boolean(dependencies.shouldStop?.())});}catch{console.warn("[operator-runtime] Verificação de finalização pendente; nova leitura no próximo ciclo.");}finally{busy=false;}};
  const timer=setInterval(()=>void tick(),15000);timer.unref();
  return()=>{stopped=true;clearInterval(timer);};
}
