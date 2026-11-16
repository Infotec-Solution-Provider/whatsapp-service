import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, json } from "express";
import { canonicalRuntimeInstance, OperatorRuntimeError, type RuntimeDb } from "./core";
import { parseCommand } from "./contract";
import { readRuntimeConfig, readRuntimeKey, type OperatorRuntimeConfig } from "./config";
import { runCentralRuntime } from "./engine";
import { OperatorFeatureError } from "../operator-features/rollout";

export function createOperatorRuntimeRouter(database: RuntimeDb, readConfig:()=>OperatorRuntimeConfig=readRuntimeConfig, readKey:(config:OperatorRuntimeConfig)=>Buffer=readRuntimeKey) {
	const router=Router(),nonces=new Map<string,number>();let active=0;
	router.get("/api/internal/operator-runtime/health",(req,res)=>{
		try{
			const config=readConfig(),key=readKey(config),now=Date.now(),timestamp=req.get("x-operator-timestamp")||"",nonce=req.get("x-operator-nonce")||"",signature=req.get("x-operator-signature")||"";
			if(Object.keys(req.query).length||!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9-]{36}$/i.test(nonce)||!/^[a-f0-9]{64}$/i.test(signature))return res.status(401).json({code:"OPERATOR_RUNTIME_UNAUTHORIZED",outcome:"NOT_COMMITTED"});
			const expected=createHmac("sha256",key).update(`${timestamp}\n${nonce}\n${req.originalUrl}\n`).digest();
			if(!timingSafeEqual(expected,Buffer.from(signature,"hex")))return res.status(401).json({code:"OPERATOR_RUNTIME_UNAUTHORIZED",outcome:"NOT_COMMITTED"});
			for(const[id,until]of nonces)if(until<now)nonces.delete(id);
			if(nonces.has(nonce)||nonces.size>=10000)return res.status(409).json({code:"OPERATOR_RUNTIME_TRANSPORT_REPLAY",outcome:"UNKNOWN"});
			nonces.set(nonce,now+60000);return res.json({service:"whatsapp",authority:"central-v1",protocolVersion:1,instances:config.instances,profile:"valid"});
		}catch{return res.status(503).json({code:"OPERATOR_RUNTIME_NOT_CONFIGURED",outcome:"NOT_COMMITTED"});}
	});
	router.post("/api/internal/operator-runtime/:instance/commands",json({limit:"128kb"}),async(req,res)=>{
		const reject=(status:number,code:string,outcome="NOT_COMMITTED")=>res.status(status).json({code,outcome});
		let authenticated=false;
		try{
			const config=readConfig(),instance=canonicalRuntimeInstance(req.params["instance"]),key=readKey(config),now=Date.now();
			if(Object.keys(req.query).length||Buffer.byteLength(JSON.stringify(req.body))>131072)return reject(400,"OPERATOR_RUNTIME_INVALID_REQUEST");
			const timestamp=req.get("x-operator-timestamp")||"",nonce=req.get("x-operator-nonce")||"",signature=req.get("x-operator-signature")||"";
			if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>60000||!/^[a-f0-9-]{36}$/i.test(nonce)||!/^[a-f0-9]{64}$/i.test(signature))return reject(401,"OPERATOR_RUNTIME_UNAUTHORIZED");
			const expected=createHmac("sha256",key).update(`${timestamp}\n${nonce}\n${req.originalUrl}\n${JSON.stringify(req.body)}`).digest();
			if(!timingSafeEqual(expected,Buffer.from(signature,"hex")))return reject(401,"OPERATOR_RUNTIME_UNAUTHORIZED");
			authenticated=true;
			const command=parseCommand(req.body);
			if(!config.instances.includes(instance)&&command.action!=="policy")return reject(403,"OPERATOR_RUNTIME_TENANT_FORBIDDEN");
			for(const[id,until]of nonces)if(until<now)nonces.delete(id);
			if(nonces.has(nonce))return reject(409,"OPERATOR_RUNTIME_TRANSPORT_REPLAY","UNKNOWN");
			if(nonces.size>=10000||active>=32)return reject(429,"OPERATOR_RUNTIME_BUSY");
			nonces.set(nonce,now+60000);active++;
			try{return res.json({data:await runCentralRuntime(database,instance,command)});}
			finally{active--;}
		}catch(error){
			if(error instanceof OperatorRuntimeError || error instanceof OperatorFeatureError)return reject(error.status,error.code);
			// Untyped transaction/connection failures can happen after COMMIT. Never claim rollback.
			return reject(503,authenticated?"OPERATOR_RUNTIME_QUERY_FAILED":"OPERATOR_RUNTIME_NOT_CONFIGURED",authenticated?"UNKNOWN":"NOT_COMMITTED");
		}
	});
	return router;
}
