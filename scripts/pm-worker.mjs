#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
export async function run(args,{stdin=process.stdin,stdout=process.stdout}={}){
 let errorResult=()=>({command_id:'request',outcome:'rejected',code:'INTERNAL_ERROR',exit:70,source_revision:null,generation:null,run_epoch:null,operation_receipt:null,steps:[],effects:[],obligations:[],next:[]});
 try{
  ({errorResult}=await import('./core/engine.mjs'));const {readWorkerConfig,workerRequest,installedWorkerCoverage,reconcileWorkerClaim}=await import('./core/worker-client.mjs');const {fail}=await import('./core/contracts.mjs');
  if(!args.length||args.join(' ')==='help'){stdout.write('pm-worker: private local worker coordination\nUsage: pm-worker <request|finish> --config <private-absolute-config> [--private-local] | claim --config <private-absolute-config> | coverage --installed-root <absolute-skill-root>\nRequest/claim read one JSON input. No outbound messages, installation or legacy central writes.\n');return 0;}
  if(args[0]==='coverage'&&args[1]==='--installed-root'&&args.length===3){stdout.write(JSON.stringify(await installedWorkerCoverage(args[2]))+'\n');return 0;}
  if(!['request','claim','finish'].includes(args[0])||args[1]!=='--config'||!args[2]||args.slice(3).join(' ')&&!['--private-local'].includes(args.slice(3).join(' ')))fail('INVALID_INPUT');
  const config=await readWorkerConfig(args[2]);let parts=[],size=0;for await(const part of stdin){size+=Buffer.byteLength(part);if(size>1048576)fail('INVALID_INPUT');parts.push(Buffer.from(part));}
  const {parseJSON}=await import('./core/engine.mjs');const request=parseJSON(Buffer.concat(parts).toString('utf8'));
  let output;
  if(args[0]==='claim'){
   if(Object.keys(request).sort().join(',')!=='dispatch,work')fail('INVALID_INPUT');
   const claim=await reconcileWorkerClaim(config,request.work,request.dispatch);
   output=args[3]==='--private-local'?claim:{runtime:claim.runtime,running:claim.running,reconcile_failed:claim.reconcile_failed,coverage:claim.coverage,assurance:claim.assurance??'unknown',sampled_at:claim.sampled_at,business_phase:claim.business_phase??'unknown',automatic_wake:false};
  }else{
   if(Object.keys(request).some(k=>!['command','query','input','idempotency_key','expected_revision'].includes(k))||request.command&&!request.command.startsWith('worker ')&&!['project init','project reconcile','work create'].includes(request.command)||request.query&&!['worker claim inspect','worker handoff inspect'].includes(request.query))fail('INVALID_INPUT');
   if(args[0]==='finish'&&request.command!=='worker handoff publish')fail('INVALID_INPUT');
   output=await workerRequest(config,request);
   if(args[0]==='finish'){stdout.write(JSON.stringify({handoff_published:output.exit===0,result:output})+'\n');return output.exit;}
   if(output.data&&args[3]!=='--private-local')output={available:true,private_local_required:true,stale:output.stale,coverage:config.mode,automatic_wake:false};
  }
  stdout.write(JSON.stringify(output)+'\n');return output.exit??0;
 }catch(e){const out=errorResult(e);stdout.write(JSON.stringify(out)+'\n');return out.exit;}
}
let main=false;try{main=!!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{}
if(main)process.exitCode=await run(process.argv.slice(2));
