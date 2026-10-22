import {isWorker,reduceWorker,workerClaim,workerDispatch} from './worker-domain.mjs';
import {workerIO} from './worker-io.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openLock, identity, sameIdentity, regular, directory, stateRoot, safeRoot, lockFilename } from './file-platform.mjs';
import { fail, ContractError, validate, DEFINITIONS } from './contracts.mjs';
import { digest, parseJSON, result, validateRequest, validateResult } from './engine.mjs';
import { rawHash, jsonBytes, csvRead, parseModel, modelFiles, initialize, authorize, findReplay, reduceLocal, mergeProtection, receiptFor, newId, validateLocalModel, assertTitleMerge, adopt, projectReceipt } from './file-model.mjs';
import { indexPlan, ownIndexLock, publishIndex, gitRun, parseIndex, guardGitDirectory } from './git-index.mjs';
import { REGISTRY } from './registry.mjs';
import { evaluateObligations } from './obligation-monitor.mjs';
import { validateHostDomain } from './host-domain.mjs';
import { parseExecutionInventory } from './execution-inventory.mjs';
import { verifyHostIdentity } from './host-bridge.mjs';

const validateProfile=model=>model.project.manager_binding.proof==='host-origin'?validateHostDomain(model):validateLocalModel(model);
const absent=p=>({path:p,exists:false,mode:null,digest:null,bytes:null});
const revision=files=>digest(files.map(({path,exists,mode,digest})=>({path,exists,mode,digest})).sort((a,b)=>a.path.localeCompare(b.path)));
const same=(a,b)=>a.exists===b.exists&&a.mode===b.mode&&a.digest===b.digest;
const envelope=value=>({value,digest:digest(value)});
const protectedCommands=new Set(['grant revoke','work pause','work cancel']);
export const LOCAL_COMMANDS=new Set(REGISTRY.filter(x=>x.implementation==='local-command').map(x=>x.name));
export const LOCAL_QUERIES=new Set(REGISTRY.filter(x=>x.implementation==='local-query').map(x=>x.name));

export class FileStore {
  // fault is an in-process test facility, never accepted from CLI input/environment.
  constructor(root,{state=stateRoot(),fault=async()=>{},hostIdentity=null,workerClock=()=>Date.now()}={}){this.root=root;this.state=state;this.fault=fault;this.hostIdentity=hostIdentity;this.workerClock=workerClock;}
  p(relative){if(!relative||path.isAbsolute(relative)||relative.split('/').some(x=>!x||x==='.'||x==='..')||relative.includes('\\'))fail('PATH_UNSAFE');return path.join(this.root,relative);}
  async checked(relative,{missing=false}={}) {
    const parts=relative.split('/');let current=this.root;
    for(let i=0;i<parts.length-1;i++){current=path.join(current,parts[i]);try{await directory(current);}catch(e){if(missing&&e.code==='ENOENT')return false;throw e;}}
    const file=await regular(this.p(relative),{optional:missing,allowLinks:relative.startsWith('.pm-local/')});return file;
  }
  async read(relative,{optional=false}={}) {
    if(this.localId&&!sameIdentity(await identity(this.p('.pm-local')),this.localId))fail('LOCK_UNAVAILABLE');
    const st=await this.checked(relative,{missing:optional});if(!st)return null;
    if(st.size>16*1024*1024)fail('JOURNAL_CORRUPT');
    const bytes=await fs.readFile(this.p(relative));
    if(this.localId&&!sameIdentity(await identity(this.p('.pm-local')),this.localId))fail('LOCK_UNAVAILABLE');
    return bytes;
  }
  async readObject(relative,{optional=false}={}) {
    const b=await this.read(relative,{optional});if(!b)return null;
    let e;try{e=parseJSON(b.toString('utf8'),{maxBytes:16*1024*1024});}catch{fail('JOURNAL_CORRUPT');}
    if(!e||Object.keys(e).sort().join(',')!=='digest,value'||e.digest!==digest(e.value))fail('JOURNAL_CORRUPT');
    return e.value;
  }
  async checkpoint(name){await this.lock?.assert();if(this.localId&&!sameIdentity(await identity(this.p('.pm-local')),this.localId))fail('LOCK_UNAVAILABLE');await this.fault(name);}
  async flush(filename){await this.checkpoint('before-flush');await this.lock.flush(filename);await this.checkpoint('after-flush');}
  async mkdir(relative) {
    let current='';
    for(const part of relative.split('/')){current=current?`${current}/${part}`:part;try{await fs.mkdir(this.p(current),{mode:0o700});await this.flush(path.dirname(this.p(current)));}catch(e){if(e.code!=='EEXIST')throw e;}const st=await directory(this.p(current));if(st.dev!==this.lock.rootId.dev)fail('PLATFORM_UNSUPPORTED');}
  }
  async put(relative,bytes,{exclusive=false,expected=null,parents=null}={}) {
    await this.checkpoint(`before-write:${relative}`);
    await this.checked(relative,{missing:true});
    const target=this.p(relative),temporary=`${target}.tmp-${newId()}`;
    const fd=await fs.open(temporary,'wx',0o600);
    try{await fd.writeFile(bytes);}finally{await fd.close();}
    await this.flush(temporary);
    await this.checked(relative,{missing:true});
    if(parents)await this.assertParents(parents);
    if(expected){const actual=await this.image(relative);if(!expected.some(image=>same(image,actual)))fail('RECOVERY_CONFLICT');}
    if(exclusive){await fs.link(temporary,target);await this.checkpoint(`EXCLUSIVE_LINK:${relative}`);await fs.unlink(temporary);await this.checkpoint(`EXCLUSIVE_UNLINK:${relative}`);}else await fs.rename(temporary,target);
    await this.checkpoint(`after-rename:${relative}`);await this.flush(path.dirname(target));
    await this.checkpoint(`after-write:${relative}`);
  }
  async putObject(relative,value,options){await this.put(relative,jsonBytes(envelope(value)),options);}
  async image(relative) {
    const st=await this.checked(relative,{missing:true});if(!st)return absent(relative);
    const bytes=await this.read(relative);
    return {path:relative,exists:true,mode:st.mode&0o777,digest:rawHash(bytes),bytes:bytes.toString('base64')};
  }
  async source() {
    let names=['TASKS.csv','.pm/project.yaml'];
    for(const dir of ['work-items','evidence/pm']){
      try{await directory(this.p(dir));for(const name of (await fs.readdir(this.p(dir))).sort()){
        if(name.endsWith(dir==='work-items'?'.yaml':'.json'))names.push(`${dir}/${name}`);
      }}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return Promise.all(names.sort().map(p=>this.image(p)));
  }
  async gitToken({allowConflict=false,allowIndexLock=this.indexPlan}={}) {
    try{await fs.lstat(this.p('.git'));}catch(e){if(e.code==='ENOENT')return {kind:'none'};throw e;}
    try{await guardGitDirectory(this.root);}catch(e){if(e.code==='ENOENT')fail('PLATFORM_UNSUPPORTED');throw e;}
    const safeArgs=['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',this.root];
    const env={PATH:process.env.PATH,HOME:process.env.HOME,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
    const run=args=>{const r=spawnSync('git',[...safeArgs,...args],{encoding:null,env});if(r.error||r.status!==0)fail('GIT_CONFLICT');return r.stdout;};
    const probe=spawnSync('git',[...safeArgs,'rev-parse','--show-toplevel'],{encoding:'utf8',env});
    if(probe.status!==0){try{await fs.lstat(this.p('.git'));fail('GIT_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}return {kind:'none'};}
    const top=await fs.realpath(probe.stdout.trim());if(top!==this.root)fail('GIT_CONFLICT');
    const gitdir=run(['rev-parse','--absolute-git-dir']).toString().trim();await directory(gitdir);
    const indexPath=path.join(gitdir,'index');
    let index=null;try{const st=await fs.lstat(indexPath);if(!st.isFile()||st.isSymbolicLink())fail('PATH_UNSAFE');const bytes=await fs.readFile(indexPath);parseIndex(bytes);index=rawHash(bytes);if(st.dev!==this.lock.rootId.dev)fail('PLATFORM_UNSUPPORTED');}catch(e){if(e.code!=='ENOENT')throw e;}
    try{const held=await identity(path.join(gitdir,'index.lock'));if(!allowIndexLock||!sameIdentity(held,allowIndexLock.seed_identity))fail('LOCK_UNAVAILABLE');}catch(e){if(e.code!=='ENOENT')throw e;}
    const states={};for(const name of ['HEAD','MERGE_HEAD','MERGE_MSG','MERGE_MODE','CHERRY_PICK_HEAD','REVERT_HEAD','ORIG_HEAD','config']){try{await regular(path.join(gitdir,name));states[name]=rawHash(await fs.readFile(path.join(gitdir,name)));}catch(e){if(e.code!=='ENOENT')throw e;}}
    for(const name of ['rebase-merge','rebase-apply']){try{await fs.lstat(path.join(gitdir,name));fail('UNSUPPORTED_RESOLUTION_STATE');}catch(e){if(e.code!=='ENOENT')throw e;}}
    const unmerged=!!run(['ls-files','--unmerged','-z']).length;if(unmerged&&!states.MERGE_HEAD)fail('UNSUPPORTED_RESOLUTION_STATE');if(unmerged&&!allowConflict)fail('GIT_CONFLICT');
    const symbolic=spawnSync('git',[...safeArgs,'symbolic-ref','-q','HEAD'],{encoding:'utf8',env});
    const ref=symbolic.status===0?symbolic.stdout.trim():null;
    const head=spawnSync('git',[...safeArgs,'rev-parse','--verify','HEAD'],{encoding:'utf8',env});
    return {kind:'git',directory:await identity(gitdir),index,unmerged,states,ref,head:head.status===0?head.stdout.trim():null};
  }
  async begin({create=false,read=false,adopting=false,bootstrapDigest=null}={}) {
    this.root=await safeRoot(this.root);
    const platform=await fs.statfs(this.root);
    if(process.platform!=='darwin'||platform.type!==26)fail('PLATFORM_UNSUPPORTED');
    try{const gitEntry=await fs.lstat(this.p('.git'));if(!gitEntry.isDirectory()||gitEntry.isSymbolicLink())fail('PLATFORM_UNSUPPORTED');await guardGitDirectory(this.root);}catch(e){if(e.code!=='ENOENT')throw e;}
    this.lock=await openLock(this.root,{mode:read?'read':'write',create,state:this.state});
    this.root=this.lock.root;
    try{
      this.pin=await this.readObject('.pm-local/identity.json',{optional:true});
      if(this.pin){
        if(!sameIdentity(this.pin.root,this.lock.rootId)||!sameIdentity(this.pin.lock,this.lock.lockId)||this.pin.uid!==process.getuid())fail('LOCK_UNAVAILABLE');
        if(!sameIdentity(this.pin.local_dir,await identity(this.p('.pm-local'))))fail('LOCK_UNAVAILABLE');
        this.localId=this.pin.local_dir;
        if((await this.read('.pm-local/.gitignore',{optional:true}))?.toString()!=='*\n')fail('RECOVERY_REQUIRED');
      }else if(!create)fail('RECOVERY_REQUIRED');
      else {
        // Missing safety identity is never silently recreated for an existing project.
        if(adopting){
          const model=validateLocalModel(parseModel(await this.source()));
          if(model.project.manager_binding.principal!=='local-owner'||model.project.manager_binding.proof!=='local-os-owner'||model.project.manager_binding.route)fail('CAPABILITY_UNAVAILABLE');
        }else for(const name of ['TASKS.csv','.pm'])try{await fs.lstat(this.p(name));fail('RECOVERY_REQUIRED');}catch(e){if(e.code!=='ENOENT')throw e;}
        const bootstrap=`${this.lock.filename}.bootstrap`;
        let binding;
        try {await regular(bootstrap,{allowLinks:true});const e=parseJSON((await fs.readFile(bootstrap)).toString('utf8'));if(e.digest!==digest(e.value))fail('JOURNAL_CORRUPT');binding=e.value;}
        catch(e){if(e.code!=='ENOENT')throw e;
          try{await fs.lstat(this.p('.pm-local'));fail('RECOVERY_REQUIRED');}catch(e){if(e.code!=='ENOENT')throw e;}
          binding={root:this.lock.rootId,lock:this.lock.lockId,uid:process.getuid(),assurance:'owner-attested'};
          const temporary=`${bootstrap}.tmp-${newId()}`,f=await fs.open(temporary,'wx',0o600);await f.writeFile(jsonBytes(envelope(binding)));await f.close();await this.flush(temporary);await fs.link(temporary,bootstrap);await this.checkpoint('BOOTSTRAP_LINK');await fs.unlink(temporary);await this.checkpoint('BOOTSTRAP_UNLINK');
        }
        await this.flush(bootstrap);await this.flush(path.dirname(bootstrap));
        if(!sameIdentity(binding.root,this.lock.rootId)||!sameIdentity(binding.lock,this.lock.lockId)||binding.uid!==process.getuid())fail('LOCK_UNAVAILABLE');
        await this.mkdir('.pm-local');
        const ignore=await this.read('.pm-local/.gitignore',{optional:true});
        if(ignore&&ignore.toString()!=='*\n')fail('RECOVERY_REQUIRED');
        if(!ignore)await this.put('.pm-local/.gitignore',Buffer.from('*\n'),{exclusive:true});
        await this.mkdir('.pm-local/transactions');await this.mkdir('.pm-local/snapshots');await this.mkdir('.pm-local/protection');await this.mkdir('.pm-local/cases');
        this.localId=await identity(this.p('.pm-local'));
        this.pin={...binding,local_dir:this.localId,checkout_origin:adopting?'adopted':'initialized',execution_activation_required:true,bootstrap_input_digest:bootstrapDigest};
        await this.putObject('.pm-local/identity.json',this.pin,{exclusive:true});
      }
      return this;
    }catch(e){await this.end();throw e;}
  }
  async end(){if(this.lock){const lock=this.lock;this.lock=null;await lock.release();}}
  async publication(){return this.readObject('.pm-local/publication.json',{optional:true});}
  safetyFilename(){return lockFilename(this.lock.rootId,path.join(this.state,'safety'));}
  async localProtections(){const events=[];for(const file of (await fs.readdir(this.p('.pm-local/protection'))).filter(f=>/^\d+\.json$/.test(f))){const e=await this.readObject(`.pm-local/protection/${file}`);if(`${e.seq}.json`!==file)fail('JOURNAL_CORRUPT');events.push(e);}return events;}
  async ledger({bootstrap=false}={}) {
    const filename=this.safetyFilename(),pin=await this.readObject('.pm-local/safety-identity.json',{optional:bootstrap});
    let actual;try{actual=await identity(filename);}catch(e){if(e.code==='ENOENT')fail('LOCK_UNAVAILABLE');throw e;}if(pin&&!sameIdentity(pin,actual))fail('LOCK_UNAVAILABLE');
    await regular(filename);const bytes=await fs.readFile(filename);if(bytes.length>16*1024*1024)fail('JOURNAL_CORRUPT');
    if(!bytes.length){if(!bootstrap)fail('JOURNAL_CORRUPT');return {header:null,events:[],tail:Buffer.alloc(0),complete:0};}
    const complete=bytes.lastIndexOf(10)+1,tail=bytes.subarray(complete),lines=bytes.subarray(0,complete).toString('utf8').split('\n').slice(0,-1),values=[];
    if(!lines.length&&bootstrap){const expected=Buffer.from(JSON.stringify(envelope({format:'project-protection/1',root:this.lock.rootId,lock:actual}))+'\n');if(expected.subarray(0,bytes.length).equals(bytes))return {header:null,events:[],tail:bytes,complete:0};}
    for(const line of lines){let e;try{e=parseJSON(line,{maxBytes:16*1024*1024});}catch{fail('JOURNAL_CORRUPT');}if(e.digest!==digest(e.value))fail('JOURNAL_CORRUPT');values.push(e.value);}
    const header=values.shift();if(header?.format!=='project-protection/1'||!sameIdentity(header.root,this.lock.rootId)||!sameIdentity(header.lock,actual))fail('JOURNAL_CORRUPT');
    return {header,events:values,tail,complete};
  }
  async protections() {
    const ledger=await this.ledger(),local=await this.localProtections(),bySeq=new Map();
    for(const event of [...ledger.events,...local]){validateRequest(event.request);if(!protectedCommands.has(event.request.command)||!Number.isSafeInteger(event.seq)||event.seq<1)fail('JOURNAL_CORRUPT');const old=bySeq.get(event.seq);if(old&&digest(old)!==digest(event))fail('JOURNAL_CORRUPT');bySeq.set(event.seq,event);}
    const events=[...bySeq.values()].sort((a,b)=>a.seq-b.seq);if(events.some((e,i)=>e.seq!==i+1))fail('JOURNAL_CORRUPT');
    if(ledger.tail.length){const next=events[ledger.events.length],line=next&&Buffer.from(JSON.stringify(envelope(next))+'\n');if(!line||!line.subarray(0,ledger.tail.length).equals(ledger.tail))fail('JOURNAL_CORRUPT');}
    return events;
  }
  async ensureLedger({bootstrap=false}={}) {
    const filename=this.safetyFilename(),ledger=await this.ledger({bootstrap});
    if(!ledger.header){const header={format:'project-protection/1',root:this.lock.rootId,lock:await identity(filename)};if(ledger.tail.length){const f=await fs.open(filename,'r+');await f.truncate(0);await f.close();}await fs.appendFile(filename,JSON.stringify(envelope(header))+'\n');await this.flush(filename);return;}
    if(bootstrap&&!await this.readObject('.pm-local/safety-identity.json',{optional:true})){
      if(ledger.events.length||ledger.tail.length||(await this.localProtections()).length)fail('LOCK_UNAVAILABLE');
      return;
    }
    const events=await this.protections();
    if(ledger.complete+events.slice(ledger.events.length).reduce((n,e)=>n+Buffer.byteLength(JSON.stringify(envelope(e))+'\n'),0)>16*1024*1024)fail('CAPABILITY_UNAVAILABLE');
    if(ledger.tail.length){const f=await fs.open(filename,'r+');await f.truncate(ledger.complete);await f.close();await this.flush(filename);}
    for(const event of events.slice(ledger.events.length)){await fs.appendFile(filename,JSON.stringify(envelope(event))+'\n');await this.flush(filename);await this.checkpoint('PROTECTION_LEDGER_DURABLE');}
  }
  async safety(action,{create=false}={}) {
    const safetyState=path.join(this.state,'safety');
    const lock=await openLock(this.root,{state:safetyState,create});
    try{
      const pin=await this.readObject('.pm-local/safety-identity.json',{optional:true});
      if(pin){if(!sameIdentity(pin,lock.lockId))fail('LOCK_UNAVAILABLE');}
      else {if(!create)fail('LOCK_UNAVAILABLE');await this.ensureLedger({bootstrap:true});await this.putObject('.pm-local/safety-identity.json',lock.lockId,{exclusive:true});}
      await this.ensureLedger();
      return await action();
    }finally{await lock.release();}
  }
  async pending() {
    const pending=[];
    for(const txid of (await fs.readdir(this.p('.pm-local/transactions'))).filter(x=>/^[a-f0-9-]{36}$/.test(x)).sort()){
      await directory(this.p(`.pm-local/transactions/${txid}`));
      if(await this.readObject(`.pm-local/transactions/${txid}/terminal.json`,{optional:true}))continue;
      const journal=await this.readObject(`.pm-local/transactions/${txid}/journal.json`,{optional:true});
      if(!journal){if(await this.read(`.pm-local/transactions/${txid}/DECIDED.json`,{optional:true})||await this.read(`.pm-local/transactions/${txid}/chain.json`,{optional:true}))fail('JOURNAL_CORRUPT');continue;}
      const decided=await this.readObject(`.pm-local/transactions/${txid}/DECIDED.json`,{optional:true});
      if(decided&&decided.journal_digest!==digest(journal))fail('JOURNAL_CORRUPT');
      if(journal.txid!==txid||!sameIdentity(journal.root,this.lock.rootId))fail('JOURNAL_CORRUPT');
      for(const set of [journal.before,journal.after]){
        if(!Array.isArray(set)||new Set(set.map(x=>x.path)).size!==set.length)fail('JOURNAL_CORRUPT');
        for(const image of set){this.p(image.path);if(!['TASKS.csv','.pm/project.yaml'].includes(image.path)&&!/^work-items\/[A-Za-z0-9][A-Za-z0-9._:-]*\.yaml$/.test(image.path)&&!/^evidence\/pm\/[A-Za-z0-9._-]+\.json$/.test(image.path))fail('JOURNAL_CORRUPT');if(image.exists){if(![0o600,0o644].includes(image.mode)||image.digest!==rawHash(Buffer.from(image.bytes,'base64')))fail('JOURNAL_CORRUPT');}else if(image.mode!==null||image.digest!==null||image.bytes!==null)fail('JOURNAL_CORRUPT');}
      }
      if(journal.before_revision!==revision(journal.before)||journal.after_revision!==revision(journal.after))fail('JOURNAL_CORRUPT');
      pending.push({journal,decided});
    }
    return pending;
  }
  async saveCase(code,units,current) {
    units=await this.pending();
    const c={reason:code,units:units.map(x=>({txid:x.journal.txid,digest:digest(x.journal),decided:!!x.decided})),current_revision:revision(current),git:await this.gitToken({allowConflict:true}),protection_digest:digest(await this.protections())};
    const case_digest=digest(c),id=case_digest.slice(7);
    const casePath=`.pm-local/cases/${id}.json`;
    if(!await this.readObject(casePath,{optional:true}))await this.putObject(casePath,{...c,id,case_digest,current},{exclusive:true});
    const e=new ContractError(code);e.caseId=id;throw e;
  }
  async assertParents(parents) {
    if(!Array.isArray(parents))fail('JOURNAL_CORRUPT');
    for(const parent of parents){try{if(!sameIdentity(await identity(this.p(parent.path)),parent.identity))fail('RECOVERY_CONFLICT');const st=await directory(this.p(parent.path));if(st.uid!==process.getuid()||(st.mode&0o022))fail('RECOVERY_CONFLICT');}catch(e){if(e.code==='EACCES')throw e;if(e instanceof ContractError&&e.code==='RECOVERY_CONFLICT')throw e;fail('RECOVERY_CONFLICT');}}
  }
  async prepare(before,after,request,{unit=newId(),predecessor=null,protection_seq=0,resolution=null,git_index=null}={}) {
    validateProfile(parseModel(after));
    if(new Set(after.map(f=>f.path.toLowerCase())).size!==after.length)fail('PATH_UNSAFE');
    this.indexPlan=git_index;
    const parents=[],created_dirs=[];
    for(const dir of [...new Set(after.filter(f=>f.exists).map(f=>path.posix.dirname(f.path)).filter(p=>p!=='.'))].sort()){
      try{await directory(this.p(dir));}catch(e){if(e.code!=='ENOENT')throw e;await this.mkdir(dir);created_dirs.push(dir);}
      const parentId=await identity(this.p(dir));if(parentId.dev!==this.lock.rootId.dev)fail('PLATFORM_UNSUPPORTED');
      parents.push({path:dir,identity:parentId});
    }
    const txid=newId(),git_before=await this.gitToken({allowConflict:!!git_index});
    const git=git_index?{...git_before,index:git_index.after_digest,unmerged:false}:git_before;
    const journal={version:1,txid,unit,root:this.lock.rootId,operation_id:(request.command?findReplay(parseModel(after),request)?.operation_receipt:null)??newId(),input_digest:digest(request),before,after,before_revision:revision(before),after_revision:revision(after),parents,created_dirs,git,git_before,git_index,protection_seq,predecessor,resolution};
    this.pendingOperationId=journal.operation_id;
    if(jsonBytes(envelope(journal)).length>16*1024*1024)fail('CAPABILITY_UNAVAILABLE');
    await this.mkdir(`.pm-local/transactions/${txid}`);
    await this.putObject(`.pm-local/transactions/${txid}/journal.json`,journal,{exclusive:true});
    await this.checkpoint('PREPARED');
    // Durable chain registration precedes DECIDED; the predecessor stays immutable.
    await this.putObject(`.pm-local/transactions/${txid}/chain.json`,{unit,txid,predecessor,journal_digest:digest(journal)},{exclusive:true});
    if(git_index)await ownIndexLock(this,git_index);
    if(revision(await this.source())!==journal.before_revision||digest(await this.gitToken({allowConflict:!!git_index}))!==digest(git_before))fail('VERSION_CONFLICT');
    if(digest(await this.readObject(`.pm-local/transactions/${txid}/journal.json`))!==digest(journal))fail('JOURNAL_CORRUPT');
    await this.checkpoint('before-DECIDED');
    if(this.hostIdentity&&request===this.activeRequest)verifyHostIdentity(this.hostIdentity,request);
    await this.safety(async()=>{
      if(request.idempotency_key)for(const e of await this.protections())if(e.request.idempotency_key===request.idempotency_key&&digest(e.request)!==digest(request))fail('IDEMPOTENCY_CONFLICT');
      await this.putObject(`.pm-local/transactions/${txid}/DECIDED.json`,{journal_digest:digest(journal)},{exclusive:true});
      this.decided=journal.txid;
    });
    await this.checkpoint('DECIDED');return {journal,decided:{journal_digest:digest(journal)}};
  }
  async verifyDecided(journal) {
    const disk=await this.readObject(`.pm-local/transactions/${journal.txid}/journal.json`),slot=await this.readObject(`.pm-local/transactions/${journal.txid}/chain.json`),decision=await this.readObject(`.pm-local/transactions/${journal.txid}/DECIDED.json`);
    if(digest(disk)!==digest(journal)||slot.unit!==journal.unit||slot.txid!==journal.txid||slot.journal_digest!==digest(journal)||digest(slot.predecessor)!==digest(journal.predecessor)||decision.journal_digest!==digest(journal))fail('JOURNAL_CORRUPT');
  }
  async apply(journal) {
    this.decided=journal.txid;this.pendingOperationId=journal.operation_id;
    await this.verifyDecided(journal);
    this.indexPlan=journal.git_index;
    await this.assertParents(journal.parents);
    const gitMatches=async()=>{const token=await this.gitToken({allowConflict:!!journal.git_index});return digest(token)===digest(journal.git)||(journal.git_index&&digest(token)===digest(journal.git_before));};
    if(!await gitMatches())fail('GIT_CONFLICT');
    if(journal.git_index)await ownIndexLock(this,journal.git_index,{decided:true});
    // Validate the entire readset, including unchanged and newly discovered paths.
    const current=await this.source(),paths=new Set([...current,...journal.before,...journal.after].map(x=>x.path));
    for(const p of paths){const c=current.find(x=>x.path===p)??absent(p),b=journal.before.find(x=>x.path===p)??absent(p),a=journal.after.find(x=>x.path===p)??absent(p);if(!same(c,b)&&!same(c,a))return this.saveCase('RECOVERY_CONFLICT',[{journal,decided:true}],current);}
    for(const after of journal.after){
      const before=journal.before.find(x=>x.path===after.path)??absent(after.path),current=await this.image(after.path);
      if(same(current,after))continue;if(!same(current,before))return this.saveCase('RECOVERY_CONFLICT',[{journal,decided:true}],await this.source());
      if(!after.exists)fail('INVARIANT_VIOLATION'); // This slice never deletes business history.
      await this.mkdir(path.posix.dirname(after.path)==='.'?'.pm':path.posix.dirname(after.path));
      if(!await gitMatches())fail('GIT_CONFLICT');
      await this.put(after.path,Buffer.from(after.bytes,'base64'),{expected:[before,after],parents:journal.parents});
      await this.checkpoint(`applied:${after.path}`);
    }
    if(revision(await this.source())!==journal.after_revision)fail('RECOVERY_CONFLICT');
    if(journal.git_index){if(!await gitMatches())fail('GIT_CONFLICT');await publishIndex(this,journal.git_index);}
    parseModel(await this.source());await this.checkpoint('VERIFIED');
  }
  afterFiles(before,model) {
    const replacements=modelFiles(model);
    const files=before.filter(x=>!replacements.some(r=>r.path===x.path));
    for(const r of replacements)files.push({path:r.path,exists:true,mode:0o600,digest:rawHash(r.bytes),bytes:r.bytes.toString('base64')});
    return files.sort((a,b)=>a.path.localeCompare(b.path));
  }
  async finish(chain) {
    this.orderChain(chain);
    for(const {journal} of chain)await this.verifyDecided(journal);
    let last=chain.at(-1).journal;
    await this.apply(last);
    for(;;){
      const events=await this.protections(),seq=events.at(-1)?.seq??0;
      const protectedBefore=await this.source(),baseModel=parseModel(protectedBefore),protectedModel=mergeProtection(baseModel,events);
      if(seq>last.protection_seq||digest(baseModel)!==digest(protectedModel)){
        const before=protectedBefore,model=protectedModel;
        const successor=await this.prepare(before,this.afterFiles(before,model),{kind:'protection-successor',seq},{unit:last.unit,predecessor:{txid:last.txid,journal_digest:digest(last),after_revision:last.after_revision},protection_seq:seq});
        chain.push(successor);last=successor.journal;await this.apply(last);continue;
      }
      const old=await this.publication(),generation=(old?.generation??0)+1;
      const files=await this.source();parseModel(files);
      await this.assertParents(last.parents);
      if(revision(files)!==last.after_revision||digest(await this.gitToken())!==digest(last.git))fail('RECOVERY_CONFLICT');
      const snapshot={project_id:parseModel(files).project.project_id,generation,source_revision:revision(files),files};
      const snap=newId();await this.putObject(`.pm-local/snapshots/${snap}.json`,snapshot,{exclusive:true});
      await this.checkpoint('SNAPSHOT_READY');
      const published=await this.safety(async()=>{
        if((await this.protections()).length!==seq)return false;
        await this.assertParents(last.parents);
        if(revision(await this.source())!==last.after_revision||digest(await this.gitToken())!==digest(last.git))fail('RECOVERY_CONFLICT');
        const publication={version:1,generation,source_revision:last.after_revision,snapshot:snap,snapshot_digest:digest(snapshot),protection_seq:seq,git:last.git,unit:last.unit,chain:chain.map(({journal})=>({txid:journal.txid,digest:digest(journal)})),absorbed:chain[0].journal.resolution?.absorbed??[]};
        await this.checkpoint('before-PUBLICATION');await this.putObject('.pm-local/publication.json',publication);this.published=publication;this.decided=null;await this.checkpoint('PUBLICATION');return true;
      });
      if(!published)continue;
      await this.checkpoint('PUBLICATION_RELEASED');
      const publication=await this.publication();
      for(const {journal} of chain)await this.putObject(`.pm-local/transactions/${journal.txid}/terminal.json`,{publication},{exclusive:true});
      for(const x of publication.absorbed)await this.putObject(`.pm-local/transactions/${x.txid}/terminal.json`,{publication,absorbed:true},{exclusive:true});
      return await this.publication();
    }
  }
  async rebuildPublication(publication=null) {
    // A lost projection is reconstructed only from a retained, published proof.
    const records=[];
    for(const id of await fs.readdir(this.p('.pm-local/transactions'))){if(!/^[a-f0-9-]{36}$/.test(id))continue;const terminal=await this.readObject(`.pm-local/transactions/${id}/terminal.json`,{optional:true});if(terminal?.publication)records.push(terminal.publication);}
    if(!records.length&&!publication)return null;
    records.sort((a,b)=>b.generation-a.generation);const pub=publication??records[0];let files=await this.source();
    if(revision(files)!==pub.source_revision){
      const last=pub.chain.at(-1),journal=await this.readObject(`.pm-local/transactions/${last.txid}/journal.json`),decided=await this.readObject(`.pm-local/transactions/${last.txid}/DECIDED.json`);
      if(last.digest!==digest(journal)||decided.journal_digest!==digest(journal)||journal.after_revision!==pub.source_revision||!sameIdentity(journal.root,this.lock.rootId))fail('JOURNAL_CORRUPT');
      files=[...journal.after].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    }
    parseModel(files);
    const snap={project_id:parseModel(files).project.project_id,generation:pub.generation,source_revision:pub.source_revision,files};
    if(digest(snap)!==pub.snapshot_digest)fail('JOURNAL_CORRUPT');
    const stored=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`,{optional:true});
    if(!stored){await this.mkdir('.pm-local/snapshots');await this.putObject(`.pm-local/snapshots/${pub.snapshot}.json`,snap,{exclusive:true});}
    else if(digest(stored)!==pub.snapshot_digest)fail('JOURNAL_CORRUPT');
    await this.putObject('.pm-local/publication.json',pub);return pub;
  }
  orderChain(members) {
    const ordered=[];let prev=null;
    for(;;){const next=members.filter(x=>!ordered.includes(x)&&((!prev&&!x.journal.predecessor)||(prev&&x.journal.predecessor?.txid===prev.journal.txid)));if(next.length>1)fail('JOURNAL_CORRUPT');if(!next.length)break;const member=next[0];if(prev&&(!prev.decided||member.journal.predecessor.journal_digest!==digest(prev.journal)||member.journal.before_revision!==prev.journal.after_revision))fail('JOURNAL_CORRUPT');ordered.push(member);prev=member;}
    if(ordered.length!==members.length)fail('JOURNAL_CORRUPT');return ordered;
  }
  activeRecovery(pending) {
    if(!pending.length)return null;
    const units=new Map();for(const p of pending){const members=units.get(p.journal.unit)??[];members.push(p);units.set(p.journal.unit,members);}
    const chains=new Map([...units].map(([unit,members])=>[unit,this.orderChain(members)]));
    const resolutions=pending.filter(p=>p.journal.resolution);
    for(const r of resolutions){
      if(chains.get(r.journal.unit)[0]!==r)fail('JOURNAL_CORRUPT');
      const seen=new Set();for(const x of r.journal.resolution.absorbed){const original=pending.find(p=>p.journal.txid===x.txid);if(!original||seen.has(x.txid)||original.journal.unit===r.journal.unit||!original.decided||digest(original.journal)!==x.digest)fail('JOURNAL_CORRUPT');seen.add(x.txid);}
    }
    const roots=resolutions.filter(r=>!resolutions.some(other=>other.journal.resolution.absorbed.some(x=>x.txid===r.journal.txid)));
    if(resolutions.length){
      if(roots.length!==1)fail('JOURNAL_CORRUPT');const root=roots[0];
      if(pending.some(p=>p.journal.unit!==root.journal.unit&&!root.journal.resolution.absorbed.some(x=>x.txid===p.journal.txid)))fail('JOURNAL_CORRUPT');
      return {root,chain:chains.get(root.journal.unit)};
    }
    if(units.size!==1)fail('JOURNAL_CORRUPT');return {root:null,chain:[...chains.values()][0]};
  }
  titleOnlyRows(expected,actual,work) {
    const erase=rows=>rows.map(r=>({...r,...(r.id===work?{title:''}:{})}));return digest(erase(expected))===digest(erase(actual));
  }
  async caseProjection(c,pub,current,pending,events) {
    const base=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`);let active;try{active=this.activeRecovery(pending);}catch{}const last=active?.chain.at(-1);
    const before=last?.journal.before??base.files,after=last?.journal.after??[];
    const paths=[...new Set([...before,...after,...c.current].map(x=>x.path))].sort();
    const value={id:c.id,case_digest:c.case_digest,reason:c.reason,current:c.current_revision===revision(current)&&digest(c.git)===digest(await this.gitToken({allowConflict:true}))&&c.protection_digest===digest(events)&&digest(c.units)===digest(pending.map(x=>({txid:x.journal.txid,digest:digest(x.journal),decided:!!x.decided}))),current_revision:c.current_revision,transactions:c.units.map(x=>x.txid),allowed_decisions:[],affected_paths:paths.map(p=>({path:p,before:before.find(x=>x.path===p)?.digest??null,after:after.find(x=>x.path===p)?.digest??null,current:c.current.find(x=>x.path===p)?.digest??null}))};
    try{
      if(c.git.unmerged&&!pending.length){
        const gitdir=gitRun(this.root,['rev-parse','--absolute-git-dir']).toString().trim();
        if(parseIndex(await fs.readFile(path.join(gitdir,'index'))).entries.some(e=>e.stage&&e.name!=='TASKS.csv'))return value;
        const stages=[1,2,3].map(n=>gitRun(this.root,['show',`:${n}:TASKS.csv`])),rows=stages.map(csvRead);
        const stageModel=parseModel(c.current.map(f=>f.path==='TASKS.csv'?{...f,bytes:stages[1].toString('base64'),digest:rawHash(stages[1])}:f));
        const ids=rows[0].filter(r=>rows.some(rs=>rs.find(x=>x.id===r.id)?.title!==r.title)).map(r=>r.id);
        if(ids.length!==1)return value;const erase=rs=>rs.map(r=>({...r,...(r.id===ids[0]?{title:''}:{})}));
        assertTitleMerge(parseModel(base.files),stageModel,ids[0],events,base.files,c.current);
        if(rows.every(rs=>digest(erase(rs))===digest(erase(rows[0]))))Object.assign(value,{work_id:ids[0],title_values:rows.map(rs=>rs.find(r=>r.id===ids[0]).title),stage_digests:stages.map(rawHash),allowed_decisions:['adopt-authorized-structured-change']});
      }else if(last&&pending.every(x=>x.decided)){
        await this.assertParents(last.journal.parents);
        const expected=parseModel(after).rows,actual=csvRead(Buffer.from(c.current.find(x=>x.path==='TASKS.csv').bytes,'base64'));
        const ids=expected.filter(r=>actual.find(x=>x.id===r.id)?.title!==r.title).map(r=>r.id);
        if(ids.length!==1)return value;
        let priorRows;try{priorRows=csvRead(Buffer.from(before.find(f=>f.path==='TASKS.csv').bytes,'base64'));}catch{}
        if(!this.titleOnlyRows(expected,actual,ids[0])&&(!priorRows||!this.titleOnlyRows(priorRows,actual,ids[0])))return value;
        if(pending.some(p=>p.journal.git_index)&&c.git.index!==last.journal.git.index)return value;
        if(c.current.some(image=>image.path!=='TASKS.csv'&&!same(image,after.find(x=>x.path===image.path)??absent(image.path))&&!same(image,before.find(x=>x.path===image.path)??absent(image.path))))return value;
        Object.assign(value,{work_id:ids[0],title_values:[expected.find(r=>r.id===ids[0]).title,actual.find(r=>r.id===ids[0]).title],allowed_decisions:['retain-validated-current','complete-recorded-intent','adopt-authorized-structured-change']});
      }
    }catch{/* Unprovable case shapes expose no resolution option. */}
    return value;
  }
  async reconcile() {
    const pending=await this.pending();let pub=await this.publication();
    if(!pub)pub=await this.rebuildPublication();
    if(pub){
      let snap=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`,{optional:true});
      if(!snap){await this.rebuildPublication(pub);snap=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`);}
      if(digest(snap)!==pub.snapshot_digest||revision(snap.files)!==pub.source_revision)fail('JOURNAL_CORRUPT');
      const completed=[...pub.chain,...(pub.absorbed??[])];
      if(completed.some(x=>pending.some(p=>p.journal.txid===x.txid))&&revision(await this.source())===pub.source_revision){
        await this.flush(this.p('.pm-local/publication.json'));await this.flush(this.p('.pm-local'));
        for(const x of completed){const p=pending.find(p=>p.journal.txid===x.txid);if(p){if(x.digest!==digest(p.journal)||(!p.decided&&pub.chain.includes(x)))fail('JOURNAL_CORRUPT');await this.putObject(`.pm-local/transactions/${x.txid}/terminal.json`,{publication:pub},{exclusive:true});}}
        return this.reconcile();
      }
    }
    if(!pending.length){
      if(!pub)return null;
      if(revision(await this.source())!==pub.source_revision)await this.saveCase('RECOVERY_CONFLICT',[],await this.source());
      const events=await this.protections();
      if(events.length<pub.protection_seq)fail('JOURNAL_CORRUPT');
      const before=await this.source(),baseModel=parseModel(before),protectedModel=mergeProtection(baseModel,events);
      if(events.length>pub.protection_seq||digest(baseModel)!==digest(protectedModel)){const t=await this.prepare(before,this.afterFiles(before,protectedModel),{kind:'protection-merge'},{protection_seq:events.length});return this.finish([t]);}
      if(digest(await this.gitToken())!==digest(pub.git)){const before=await this.source(),t=await this.prepare(before,before,{kind:'git-anchor-refresh'},{protection_seq:events.length});return this.finish([t]);}
      return pub;
    }
    const active=this.activeRecovery(pending);
    if(active.root){
      const r=active.root;
      for(const x of r.journal.resolution.absorbed){const original=pending.find(p=>p.journal.txid===x.txid);if(!original||digest(original.journal)!==x.digest)fail('JOURNAL_CORRUPT');}
      if(r.decided){
        const own=active.chain,last=own.at(-1),other=pending.filter(x=>x.journal.unit!==r.journal.unit);
        if(other.some(x=>!r.journal.resolution.absorbed.some(a=>a.txid===x.journal.txid)))fail('JOURNAL_CORRUPT');
        if(!last.decided){if(revision(await this.source())!==last.journal.before_revision)await this.saveCase('RECOVERY_CONFLICT',pending,await this.source());if(last.journal.git_index)await ownIndexLock(this,last.journal.git_index,{abandon:true});await this.putObject(`.pm-local/transactions/${last.journal.txid}/terminal.json`,{abandoned:true},{exclusive:true});return this.reconcile();}
        return this.finish(own);
      }
      if(revision(await this.source())!==r.journal.before_revision)await this.saveCase('RECOVERY_CONFLICT',pending,await this.source());
      if(r.journal.git_index)await ownIndexLock(this,r.journal.git_index,{abandon:true});
      await this.putObject(`.pm-local/transactions/${r.journal.txid}/terminal.json`,{abandoned:true},{exclusive:true});return this.reconcile();
    }
    const units=new Set(pending.map(x=>x.journal.unit));if(units.size!==1)fail('JOURNAL_CORRUPT');
    const ordered=this.orderChain(pending);
    const last=ordered.at(-1);
    if(!last.decided){
      if(revision(await this.source())!==last.journal.before_revision)await this.saveCase('RECOVERY_CONFLICT',pending,await this.source());
      if(last.journal.git_index)await ownIndexLock(this,last.journal.git_index,{abandon:true});
      await this.putObject(`.pm-local/transactions/${last.journal.txid}/terminal.json`,{abandoned:true},{exclusive:true});
      ordered.pop();if(!ordered.length)return pub;
    }
    for(const member of ordered){const c=await this.readObject(`.pm-local/transactions/${member.journal.txid}/chain.json`,{optional:true});if(!c||c.journal_digest!==digest(member.journal)||c.unit!==member.journal.unit)fail('JOURNAL_CORRUPT');}
    return this.finish(ordered);
  }
  async query(request) {
    await this.begin({read:true});
    try{
      const pub=await this.publication();if(!pub)fail('RECOVERY_REQUIRED');
      const snap=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`,{optional:true});if(!snap)fail('RECOVERY_REQUIRED');if(digest(snap)!==pub.snapshot_digest||revision(snap.files)!==pub.source_revision)fail('JOURNAL_CORRUPT');
      const model=parseModel(snap.files),pending=await this.pending();
      if(request.snapshot_token&&request.snapshot_token!==pub.snapshot)fail('VERSION_CONFLICT');
      const events=await this.protections();
      if(events.length<pub.protection_seq)fail('JOURNAL_CORRUPT');
      const current=await this.source(),git=await this.gitToken({allowConflict:request.query==='operation inspect'});
      const stale=!!pending.length||events.length>pub.protection_seq||revision(current)!==pub.source_revision||digest(git)!==digest(pub.git);
      let executionActivationRequired=true,activationWarning=false;
      if(model.project.manager_binding.proof==='host-origin'&&this.pin.host_activation_identity){
        try{
          if(!sameIdentity(this.pin.host_activation_identity,await identity(this.p('.pm-local/execution-activation.json'))))fail('FENCE_INVALID');
          const activation=await this.readObject('.pm-local/execution-activation.json');
          const inventory=path.join(this.state,'execution',`${digest(this.lock.rootId).slice(7)}.jsonl`);
          if(!sameIdentity(activation.root,this.lock.rootId)||activation.manager_epoch!==model.project.manager_binding.epoch||activation.host_instance!==model.project.manager_binding.route?.instance||
             !sameIdentity(activation.inventory,this.pin.host_inventory_identity)||!sameIdentity(await identity(inventory),this.pin.host_inventory_identity))fail('FENCE_INVALID');
          await regular(inventory);parseExecutionInventory(await fs.readFile(inventory),{format:'project-execution/1',root:this.lock.rootId,lock:this.pin.lock,...this.pin.host_bootstrap});
          executionActivationRequired=false;
        }catch{activationWarning=true;}
      }
      const data=request.projection==='private-local'?{projection:'private-local',runtime:{checkout_origin:this.pin.checkout_origin??'initialized',execution_activation_required:executionActivationRequired},model,effective_protection_overlay:events.map(e=>({seq:e.seq,command:e.request.command,work:e.request.input.work??null,work_ids:e.request.input.grant?.work_ids??[e.request.input.work],grant_ref:e.request.input.grant?.id??null,merged:e.seq<=pub.protection_seq,deny:true}))}:{projection:'summary',object_refs:model.rows.map((_,i)=>`work-${i+1}`)};
      if(['worker claim inspect','worker handoff inspect'].includes(request.query)&&request.projection==='private-local'){if(stale)fail('RECOVERY_REQUIRED');data.worker_view=request.query==='worker claim inspect'?{claim:workerClaim(model,request.input.dispatch,{now:this.workerClock()})}:{dispatch:workerDispatch(model,request.input.dispatch)};}
      if(request.query==='monitor evaluate'){
        if(stale)fail('RECOVERY_REQUIRED');
        if(request.input.snapshot!==pub.snapshot)fail('VERSION_CONFLICT');
        if(request.input.policy!==model.project.policy.id)fail('AUTH_DENIED');
        if(request.input.observations?.length)fail('CAPABILITY_UNAVAILABLE');
        const monitor=evaluateObligations(model,{snapshot:pub.snapshot,generation:pub.generation});
        if(request.projection==='private-local')data.monitor=monitor;
        else data.object_refs=monitor.roots.map((_,i)=>`attention-${i+1}`);
      }
      if(request.query==='operation inspect'){
        const c=/^[a-f0-9]{64}$/.test(request.input.subject)?await this.readObject(`.pm-local/cases/${request.input.subject}.json`,{optional:true}):null;
        const op=[...model.project.project_audit,...model.tasks.flatMap(t=>t.audit)].map(x=>x.operation_receipt).find(x=>x&&(x.operation_id===request.input.subject||x.idempotency_key===request.input.subject));
        const pendingOp=pending.find(p=>p.journal.txid===request.input.subject||p.journal.operation_id===request.input.subject||[...parseModel(p.journal.after).project.project_audit,...parseModel(p.journal.after).tasks.flatMap(t=>t.audit)].some(x=>x.operation_receipt?.idempotency_key===request.input.subject));
        const protectionOp=events.find(e=>e.operation_id===request.input.subject||e.request.idempotency_key===request.input.subject);
        if(!c&&!op&&!pendingOp&&!protectionOp)fail('INVALID_INPUT');
        if(request.projection==='private-local'){
          if(c)data.case=await this.caseProjection(c,pub,current,pending,events);if(op)data.operation=projectReceipt(model,op,events);
          if(protectionOp&&!op)data.pending_operation=result('PROTECTION_PENDING',protectionOp.operation_id,{operation_receipt:protectionOp.operation_id,steps:[{name:'protection',state:'durable-business-pending',facts:{protection_accepted:true,business_commit_pending:true,protection_seq:protectionOp.seq,external_calls:0},evidence:[],assurance:'owner-attested'}]});
          if(pendingOp&&!protectionOp)data.pending_operation=result(pendingOp.decided?'RECOVERY_PENDING':'NO_CHANGE',pendingOp.journal.operation_id,{operation_receipt:pendingOp.journal.operation_id,steps:[{name:'local-transaction',state:pendingOp.decided?'decided-recovery-pending':'prepared-not-decided',facts:{external_calls:0},evidence:[],assurance:'verified'}]});
        }
      }
      return {project_id:request.projection==='summary'?'local-project':model.project.project_id,schema_major:'1',source_revision:pub.source_revision,generation:pub.generation,snapshot:pub.snapshot,protection_seq:events.length,stale,recovery_required:stale,data,warnings:[...(stale?['STALE_SNAPSHOT']:[]),...(activationWarning?['CAPABILITY_UNAVAILABLE']:[])]};
    }finally{await this.end();}
  }
  async adoptionHint(request) {
    this.root=await safeRoot(this.root);
    if(process.platform!=='darwin'||(await fs.statfs(this.root)).type!==26)fail('PLATFORM_UNSUPPORTED');
    try{await fs.lstat(this.p('.pm-local'));fail('RECOVERY_REQUIRED');}catch(e){if(e.code!=='ENOENT')throw e;}
    const files=await this.source(),model=validateProfile(parseModel(files));
    if(model.project.manager_binding.principal!=='local-owner'||model.project.manager_binding.proof!=='local-os-owner'||model.project.manager_binding.route)fail('CAPABILITY_UNAVAILABLE');
    return result('RECOVERY_REQUIRED','request',{source_revision:revision(files),steps:[{name:'bootstrap',state:'unbound-source-cas-hint',facts:{external_calls:0,...(request.projection==='private-local'?{project_id:model.project.project_id,policy_ref:model.project.policy.id}:{})},evidence:[],assurance:'owner-attested'}],next:[{action:'project adopt',subject:'local-project',reason:'RECOVERY_REQUIRED',needs_decision:true,input_schema:'LocalAdoptRequest'}]});
  }
  async protect(request) {
    if(this.hostIdentity)verifyHostIdentity(this.hostIdentity,request);else if(request.actor_proof!=='local-owner')fail('AUTH_REQUIRED');
    this.root=await safeRoot(this.root);
    const pin=await this.readObject('.pm-local/identity.json');
    this.pin=pin;
    if(pin.uid!==process.getuid()||!sameIdentity(pin.root,await identity(this.root))||!sameIdentity(pin.lock,await identity(lockFilename(pin.root,this.state)))||!sameIdentity(pin.local_dir,await identity(this.p('.pm-local'))))fail('LOCK_UNAVAILABLE');
    this.localId=pin.local_dir;
    this.lock=await openLock(this.root,{state:path.join(this.state,'safety')});
    let event,durable=false;
    try{
      const safetyPin=await this.readObject('.pm-local/safety-identity.json');
      if(!sameIdentity(safetyPin,this.lock.lockId))fail('LOCK_UNAVAILABLE');
      const events=await this.protections();
      const existing=events.find(e=>e.request.idempotency_key===request.idempotency_key);
      if(existing){if(digest(existing.request)!==digest(request))fail('IDEMPOTENCY_CONFLICT');event=existing;await this.ensureLedger();durable=true;}
      else {
        if(events.length>=4096)fail('PROTECTION_NOT_DURABLE');
        const pub=await this.publication();if(!pub)fail('RECOVERY_REQUIRED');
        const snap=await this.readObject(`.pm-local/snapshots/${pub.snapshot}.json`);
        if(digest(snap)!==pub.snapshot_digest)fail('JOURNAL_CORRUPT');
        const model=parseModel(snap.files);authorize(request,model,this.hostIdentity);
        findReplay(model,request,await this.protections());
        // A damaged ordinary journal cannot prevent a trusted deny-only record.
        for(const p of await this.pending().catch(()=>[]))if(p.decided)findReplay(parseModel(p.journal.after),request);
        if(request.command==='grant revoke'){
          const grant=model.project.project_grants.find(g=>g.id===request.input.grant.id);
          if(!grant||digest(grant)!==digest(request.input.grant)||!request.input.evidence.length)fail('AUTH_DENIED');
          event={grant_digest:digest(grant)};
        }else {
          if(!model.rows.some(r=>r.id===request.input.work)||request.input.proof!==(this.hostIdentity?'host-origin':'local-owner'))fail('AUTH_DENIED');
          event={};
        }
        if(this.captureProtectionInventory)event={...event,...await this.captureProtectionInventory(model,request)};
        // P contains deny-only input and never grants or starts anything.
        event={...event,seq:events.length+1,at:new Date().toISOString(),operation_id:newId(),request,...(this.hostIdentity?{authority:{project_id:this.hostIdentity.project_id,principal:this.hostIdentity.actor,epoch:this.hostIdentity.manager_epoch,role:this.hostIdentity.role,reference:this.hostIdentity.reference}}:{})};
        await this.putObject(`.pm-local/protection/${event.seq}.json`,event,{exclusive:true});
        await this.ensureLedger();
        durable=true;
        await this.checkpoint('PROTECTION_DURABLE');
      }
    }catch(e){if(durable)return result(this.hostIdentity&&event.inflight_work_ids?.length?'STOP_UNKNOWN':'PROTECTION_PENDING',event.operation_id,{operation_receipt:event.operation_id,steps:[{name:'protection',state:'durable-business-pending',facts:{protection_accepted:true,business_commit_pending:true,external_calls:0},evidence:[],assurance:this.hostIdentity?'verified':'owner-attested'}]});if(e instanceof ContractError)throw e;fail('PROTECTION_NOT_DURABLE');}
    finally{await this.end();}
    // Never wait for project-lock while holding safety-lock.
    const follow={...request,command:'project reconcile',input:{},idempotency_key:`reconcile-${event.operation_id}`};
    try {
      if(this.hostReconcile)await this.hostReconcile();else await this.command(follow);
      const reader=new FileStore(this.root,{state:this.state});
      await reader.begin({read:true});
      try{const pub=await reader.publication(),model=parseModel(await reader.source());const replay=findReplay(model,request,await reader.protections());if(replay){
        if(this.hostIdentity&&model.tasks.some(t=>t.obligations.some(o=>o.template==='stop-proof'&&['active','waiting'].includes(o.lifecycle))))return result('STOP_UNKNOWN',event.operation_id,{operation_receipt:event.operation_id,source_revision:pub.source_revision,generation:pub.generation,steps:[{name:'protection',state:'durable-stop-unconfirmed',facts:{protection_accepted:true,business_commit_pending:false,external_calls:0},evidence:[],assurance:'verified'}]});
        return {...replay,source_revision:pub.source_revision,generation:pub.generation};
      }}finally{await reader.end();}
    }catch{/* P remains durable even if ordinary recovery is blocked. */}
    return result(this.hostIdentity&&event.inflight_work_ids?.length?'STOP_UNKNOWN':'PROTECTION_PENDING',event.operation_id,{operation_receipt:event.operation_id,steps:[{name:'protection',state:'durable-business-pending',facts:{protection_accepted:true,business_commit_pending:true,external_calls:0},evidence:[],assurance:this.hostIdentity?'verified':'owner-attested'}]});
  }
  async resolve(request) {
    await this.begin();
    try{
      if(request.actor_proof!=='local-owner'||!request.input.authorization_refs.includes('local-owner'))fail('AUTH_REQUIRED');
      const active=await this.pending(),own=active.find(p=>p.journal.resolution?.decision_digest===digest(request));
      if(own){try{await this.reconcile();}catch(e){if(own.decided||!['RECOVERY_CONFLICT','GIT_CONFLICT'].includes(e.code))throw e;}}
      let previous=await this.publication(),source=await this.source();
      if(previous&&revision(source)===previous.source_revision){previous=await this.reconcile();source=await this.source();const model=parseModel(source);authorize(request,model);const replay=findReplay(model,request,await this.protections());if(replay)return {...replay,source_revision:previous.source_revision,generation:previous.generation};}
      const c=await this.readObject(`.pm-local/cases/${request.input.case_id}.json`,{optional:true});if(!c)fail('CASE_CHANGED');
      this.resolutionCase=c.id;
      const current=await this.source(),pending=await this.pending();
      if(c.case_digest!==request.input.expected_case_digest||c.current_revision!==revision(current)||digest(c.git)!==digest(await this.gitToken({allowConflict:true}))||c.protection_digest!==digest(await this.protections())||digest(c.units)!==digest(pending.map(x=>({txid:x.journal.txid,digest:digest(x.journal),decided:!!x.decided}))))fail('CASE_CHANGED');
      const semantic=request.input.semantic_input;
      if(!semantic||!['adopt-authorized-structured-change','retain-validated-current','complete-recorded-intent'].includes(request.input.decision))fail('RESOLUTION_INPUT_REQUIRED');
      let latest,intended,currentRows,git_index=null,merge=false;
      if(!pending.length&&c.git.unmerged){
        merge=true;
        const spec=semantic.merge_resolution;
        if(!spec||spec.field!=='title'||spec.work_id!==semantic.work_id)fail('RESOLUTION_INPUT_REQUIRED');
        const stages=[1,2,3].map(n=>gitRun(this.root,['show',`:${n}:TASKS.csv`]));
        if(digest(spec.stage_digests)!==digest(stages.map(rawHash)))fail('CASE_CHANGED');
        const rows=stages.map(csvRead);
        const erase=rs=>rs.map(r=>({...r,...(r.id===semantic.work_id?{title:''}:{})}));
        if(!rows.every(rs=>digest(erase(rs))===digest(erase(rows[0]))))fail('UNSUPPORTED_RESOLUTION_STATE');
        const files=current.map(f=>f.path==='TASKS.csv'?{...f,bytes:stages[1].toString('base64'),digest:rawHash(stages[1])}:f);
        intended=parseModel(files);currentRows=rows[1];
      }else{
        if(!pending.length||pending.some(x=>!x.decided))fail('UNSUPPORTED_RESOLUTION_STATE');
        latest=this.activeRecovery(pending).chain.at(-1);
        if(!latest)fail('JOURNAL_CORRUPT');
        if(!semantic.superseded_intents.includes(latest.journal.txid))fail('RESOLUTION_INPUT_REQUIRED');
        intended=parseModel(latest.journal.after);
        currentRows=csvRead(Buffer.from(current.find(f=>f.path==='TASKS.csv').bytes,'base64'));
      }
      authorize(request,intended);
      if(merge){const snapshot=await this.readObject(`.pm-local/snapshots/${(await this.publication()).snapshot}.json`);assertTitleMerge(parseModel(snapshot.files),intended,semantic.work_id,await this.protections(),snapshot.files,current);}
      if(latest)await this.assertParents(latest.journal.parents);
      const r=intended.rows.find(r=>r.id===semantic.work_id),cr=currentRows.find(r=>r.id===semantic.work_id);
      if(!r||!cr)fail('UNSUPPORTED_RESOLUTION_STATE');
      // Only a typed label conflict is accepted by this adapter. Every other third byte stays frozen.
      if(!merge)for(const image of current){const after=latest.journal.after.find(x=>x.path===image.path)??absent(image.path),before=latest.journal.before.find(x=>x.path===image.path)??absent(image.path);if(same(image,after)||same(image,before))continue;if(image.path!=='TASKS.csv')fail('UNSUPPORTED_RESOLUTION_STATE');let priorRows;try{priorRows=csvRead(Buffer.from(before.bytes,'base64'));}catch{}if(!this.titleOnlyRows(intended.rows,currentRows,r.id)&&(!priorRows||!this.titleOnlyRows(priorRows,currentRows,r.id)))fail('UNSUPPORTED_RESOLUTION_STATE');}
      const originalTitle=r.title;
      r.title=merge?semantic.merge_resolution.value:request.input.decision==='retain-validated-current'?cr.title:request.input.decision==='complete-recorded-intent'?originalTitle:semantic.title;r.row_version++;r.updated_at=new Date().toISOString();
      intended.project.project_audit.push({event_id:newId(),at:r.updated_at,actor:'local-owner',type:'resolution',subject:r.id,payload:[{field:'superseded-intent',value:latest?.journal.txid??'git-merge'},{field:'case-ref',value:c.id},{field:'resolution-disposition',value:request.input.decision==='complete-recorded-intent'?'completed-by-resolution':'superseded'},...pending.map(p=>({field:'absorbed-operation',value:p.journal.operation_id})),{field:'reason',value:semantic.reason}],evidence:[],operation_receipt:receiptFor(request,newId())});
      const resolution={case_id:c.id,case_digest:c.case_digest,decision_digest:digest(request),absorbed:pending.map(x=>({txid:x.journal.txid,digest:digest(x.journal)}))};
      // Case includes the exact conflicting bytes; it is immutable and retained.
      const after=this.afterFiles(current,intended);
      validateLocalModel(intended);
      // A protection successor may have no new index plan while retaining an
      // ancestor's completed Git adaptation. Resolution absorbs the whole graph.
      const gitAdaptation=pending.some(p=>p.journal.git_index);
      if(gitAdaptation&&c.git.index!==latest.journal.git.index)fail('UNSUPPORTED_RESOLUTION_STATE');
      if(merge||gitAdaptation)git_index=await indexPlan(this,after,['TASKS.csv']);
      const prepared=await this.prepare(current,after,request,{resolution,git_index,protection_seq:latest?.journal.protection_seq??(await this.publication()).protection_seq});
      const pub=await this.finish([prepared]);return {...findReplay(parseModel(await this.source()),request,await this.protections()),source_revision:pub.source_revision,generation:pub.generation};
    }catch(e){
      if(this.published){const receipt=findReplay(parseModel(await this.source()),request,await this.protections());if(receipt)return {...receipt,source_revision:this.published.source_revision,generation:this.published.generation};}
      if(e instanceof ContractError)throw e;
      const pending=await this.pending().catch(()=>[]),decided=pending.find(p=>p.decided&&p.journal.resolution?.decision_digest===digest(request));
      if(decided)return result('IO_PENDING',decided.journal.operation_id,{operation_receipt:decided.journal.operation_id,steps:[{name:'resolution',state:'decided-recovery-pending',facts:{retry_same_key:true,external_calls:0},evidence:[],assurance:'verified'}]});
      if(pending.some(p=>p.decided))return result('RECOVERY_REQUIRED','resolution',{operation_receipt:pending.find(p=>p.decided).journal.operation_id,steps:[{name:'resolution',state:'preparation-blocked',facts:{blocking_code:'IO_PREPARE_FAILED',external_calls:0},evidence:[],assurance:'verified'}]});
      fail('IO_PREPARE_FAILED');
    }finally{await this.end();}
  }
  async command(request) {
    const init=['project init','flow take-control'].includes(request.command),adopting=request.command==='project adopt';
    await this.begin({create:init||adopting,adopting,bootstrapDigest:digest(request)});
    try{
      if(request.actor_proof!=='local-owner')fail('AUTH_REQUIRED');
      if((init||adopting)&&!await this.readObject('.pm-local/safety-identity.json',{optional:true})){
        if(await this.publication()||(!adopting&&(await this.image('TASKS.csv')).exists))fail('LOCK_UNAVAILABLE');
        if(adopting){
          if(await this.rebuildPublication()||(await this.pending()).some(p=>p.decided))fail('LOCK_UNAVAILABLE');
          const model=parseModel(await this.source());
          if([...model.project.project_audit,...model.tasks.flatMap(t=>t.audit)].some(a=>a.operation_receipt?.input_digest===this.pin.bootstrap_input_digest))fail('LOCK_UNAVAILABLE');
        }
        await this.safety(async()=>{}, {create:true});
      }
      const pub=await this.reconcile();
      let before=await this.source(),model;
      if(before.find(f=>f.path==='TASKS.csv')?.exists){model=parseModel(before);authorize(request,model);const replay=findReplay(model,request,await this.protections());if(replay)return {...replay,source_revision:revision(before),generation:pub?.generation??null};}
      if(init||adopting){if(await safeRoot(request.input.root)!==this.root)fail('PATH_UNSAFE');}
      if(init){if(before.some(f=>f.exists))fail('INVARIANT_VIOLATION');}
      else if(!model)fail('RECOVERY_REQUIRED');
      if(request.command==='project reconcile')return result('NO_CHANGE','reconcile',{source_revision:revision(before),generation:pub?.generation??null});
      if(request.command==='project resolve')fail('UNSUPPORTED_RESOLUTION_STATE');
      if(request.expected_revision!==revision(before))fail('VERSION_CONFLICT');
      const operationId=newId();
      if(isWorker(request.command)){
        const options={now:this.workerClock()};
        if(request.command==='worker handoff publish')reduceWorker(model,request,operationId,{...options,io:{envelope_digest:digest(request.input.envelope)}});
        const io=await workerIO(this,model,request),beforeWorker=digest(model);model=reduceWorker(model,request,operationId,{...options,io});if(digest(model)===beforeWorker)return result('NO_CHANGE',operationId,{source_revision:revision(before),generation:pub?.generation??null});
      }else model=init?initialize(request,operationId):adopting?adopt(model,request,operationId):reduceLocal(model,request,operationId);
      const after=this.afterFiles(before,model);
      const prepared=await this.prepare(before,after,request,{protection_seq:pub?.protection_seq??0});
      const publication=await this.finish([prepared]);
      const current=parseModel(await this.source()),replay=findReplay(current,request,await this.protections());
      return {...replay,source_revision:publication.source_revision,generation:publication.generation};
    }catch(e){
      if(this.published){
        const files=await this.source(),receipt=findReplay(parseModel(files),request,await this.protections());
        if(receipt&&revision(files)===this.published.source_revision)return {...receipt,source_revision:this.published.source_revision,generation:this.published.generation,steps:[...receipt.steps,{name:'local-cleanup',state:'pending',facts:{local_intent_committed:true,external_calls:0},evidence:[],assurance:'verified'}]};
      }
      if(e instanceof ContractError&&e.code==='GIT_CONFLICT')await this.saveCase('GIT_CONFLICT',await this.pending(),await this.source());
      if(e instanceof ContractError&&e.code==='RECOVERY_CONFLICT'&&!e.caseId)await this.saveCase('RECOVERY_CONFLICT',await this.pending(),await this.source());
      if(!(e instanceof ContractError)){
        const pending=await this.pending().catch(()=>[]);
        if(pending.some(x=>x.decided)){const active=pending.find(x=>x.decided&&x.journal.input_digest===digest(request))??pending.find(x=>x.decided);return result('IO_PENDING',active.journal.operation_id,{operation_receipt:active.journal.operation_id,steps:[{name:'file-commit',state:'decided-recovery-pending',facts:{retry_same_key:true,external_calls:0},evidence:[],assurance:'verified'}]});}
        if(this.decided)return result('RECOVERY_CONFLICT','pending',{operation_receipt:this.pendingOperationId??this.decided,steps:[{name:'file-commit',state:'recovery-evidence-unavailable',facts:{external_calls:0},evidence:[],assurance:'unknown'}]});
        fail('IO_PREPARE_FAILED');
      }
      throw e;
    }finally{await this.end();}
  }
}
export async function executeFiles(request,options) {
  validateRequest(request);
  const store=new FileStore(request.repo,options);
  if(request.query){
    if(!LOCAL_QUERIES.has(request.query))fail('CAPABILITY_UNAVAILABLE');
    let output;try{output=await store.query(request);}catch(e){if(request.query!=='project inspect'||e.code!=='RECOVERY_REQUIRED')throw e;try{output=await store.adoptionHint(request);}catch{throw e;}}
    if(output.exit!==undefined)validateResult(output);else validate(output,DEFINITIONS.QueryResult);return output;
  }
  if(!LOCAL_COMMANDS.has(request.command))fail('CAPABILITY_UNAVAILABLE');
  if(request.actor_proof!=='local-owner')fail('AUTH_REQUIRED');
  if(['project init','project adopt','flow take-control'].includes(request.command)&&request.input.identity!=='local-owner')fail('AUTH_REQUIRED');
  const output=protectedCommands.has(request.command)?await store.protect(request):request.command==='project resolve'?await store.resolve(request):await store.command(request);
  validateResult(output);return output;
}
export const emptyRevision=()=>revision([absent('.pm/project.yaml'),absent('TASKS.csv')]);
