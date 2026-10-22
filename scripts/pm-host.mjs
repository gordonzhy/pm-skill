#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';

export async function run(args,{stdout=process.stdout,signal=null}={}){
  let session,errorResult=()=>({command_id:'request',outcome:'rejected',code:'INTERNAL_ERROR',exit:70,source_revision:null,generation:null,run_epoch:null,operation_receipt:null,steps:[],effects:[],obligations:[],next:[]});
  try{
    ({errorResult}=await import('./core/engine.mjs'));
    const {readOwnerConfig,openOwnerHost}=await import('./core/owner-host.mjs');
    const {fail}=await import('./core/contracts.mjs');
    if(!args.length||args.join(' ')==='help'||args.join(' ')==='--help'){
      stdout.write('pm-host: explicit private owner integration\nUsage: node scripts/pm-host.mjs <inspect|prepare-controller|serve> --config <absolute-private-config> [--private-local] [--instruction <private-text-file> --message-id <stable-id>]\nNo login, global configuration change or model turn is started automatically.\n');return 0;
    }
    const [action,flag,filename,...rest]=args;
    if(flag!=='--config'||!filename||!path.isAbsolute(filename)||!['inspect','prepare-controller','serve'].includes(action))fail('INVALID_INPUT');
    const privateLocal=rest.join(' ')==='--private-local';let instruction=null;
    if(rest.length&&!privateLocal){if(action!=='serve'||rest.length!==4||rest[0]!=='--instruction'||rest[2]!=='--message-id')fail('INVALID_INPUT');instruction={filename:rest[1],id:rest[3]};}
    if(privateLocal&&action!=='prepare-controller')fail('INVALID_INPUT');
    const config=await readOwnerConfig(filename);session=await openOwnerHost(config,{action,instruction});
    stdout.write(`${JSON.stringify({...session.status,...(privateLocal?{private_local:session.privateContext}:{})})}\n`);
    if(action==='serve'){
      const controller=new AbortController(),abort=()=>controller.abort();
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
      try{
        if(session.monitor)await session.monitor.run({signal:controller.signal});
        else if(!controller.signal.aborted)await Promise.race([new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true})),session.closed.then(()=>fail('CAPABILITY_UNAVAILABLE'))]);
      }finally{signal?.removeEventListener('abort',abort);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
    }
    return 0;
  }catch(error){const output=errorResult(error);stdout.write(`${JSON.stringify(output)}\n`);return output.exit;}
  finally{session?.close();}
}
let main=false;try{main=!!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{}
if(main)process.exitCode=await run(process.argv.slice(2));
