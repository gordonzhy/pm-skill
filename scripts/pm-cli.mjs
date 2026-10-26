#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export async function run(args, {stdin=process.stdin,stdout=process.stdout}={}) {
  let errorResult=()=>({command_id:'request',outcome:'rejected',code:'INTERNAL_ERROR',exit:70,source_revision:null,generation:null,run_epoch:null,operation_receipt:null,steps:[],effects:[],obligations:[],next:[]});
  const action=args.join(' ');
  try {
    const engine=await import('./core/engine.mjs');
    const {parseJSON,validateRequest,plan,execute,assertRegistry}=engine;
    errorResult=engine.errorResult;
    const {help,capabilities,schemaDocument,apiDescription,findCommand}=await import('./core/registry.mjs');
    const {fail}=await import('./core/contracts.mjs');
    assertRegistry();
    let output;
    if(!args.length || action==='help' || action==='--help') {stdout.write(`${help()}\n`);return 0;}
    if(action==='capability inspect' || action==='inspect-capabilities')output=capabilities();
    else if(action==='schema')output=schemaDocument();
    else if(action==='api describe')output=apiDescription();
    else {
      if(!['input validate','plan'].includes(action)&&!findCommand(action))fail('INVALID_INPUT');
      let chunks=[],bytes=0;
      for await(const chunk of stdin){bytes+=Buffer.byteLength(chunk);if(bytes>1048576){chunks=[];fail('INVALID_INPUT');}chunks.push(chunk);}
      const request=parseJSON(Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('utf8'));
      const record=validateRequest(request);
      if(!['input validate','plan'].includes(action)&&action!==record.name)fail('INVALID_INPUT');
      if(action==='input validate')output={kind:'input-validation',valid:true,authorization:'not-verified',project_state:'not-read',executable:false};
      else if(action==='plan')output=plan(request);
      else output=await execute(request);
    }
    stdout.write(`${JSON.stringify(output)}\n`);return output?.exit??0;
  } catch(error) {
    if(action==='input validate'&&error?.code==='INVALID_INPUT') {
      // Diagnostics are the point of this entry: name the failing schema field, never a value.
      stdout.write(`${JSON.stringify({kind:'input-validation',valid:false,code:'INVALID_INPUT',field:error.field??null,authorization:'not-verified',project_state:'not-read',executable:false})}\n`);return 20;
    }
    const output=errorResult(error);
    // Only a stable error DTO is emitted; no supplied names, paths, proof or stderr.
    stdout.write(`${JSON.stringify(output)}\n`);return output.exit;
  }
}
let isMain=false;
try{isMain=!!process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href;}catch{/* An imported module need not have a script argv. */}
if(isMain)process.exitCode=await run(process.argv.slice(2));
