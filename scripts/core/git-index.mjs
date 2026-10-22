import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateSync, inflateSync } from 'node:zlib';
import { fail } from './contracts.mjs';
import { identity, sameIdentity, directory, regular } from './file-platform.mjs';
import { rawHash, newId } from './file-model.mjs';

const sha1=bytes=>createHash('sha1').update(bytes).digest();
export async function guardGitDirectory(root) {
  const dir=path.join(root,'.git'),rootId=await identity(root);if((await directory(dir)).dev!==rootId.dev)fail('PLATFORM_UNSUPPORTED');
  for(const name of ['CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer'])try{await fs.lstat(path.join(dir,name));fail('UNSUPPORTED_RESOLUTION_STATE');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const name of ['objects','objects/info','objects/pack','refs','refs/heads','refs/tags'])if((await directory(path.join(dir,name))).dev!==rootId.dev)fail('PLATFORM_UNSUPPORTED');
  for(const name of ['objects/info/alternates','objects/info/http-alternates','commondir'])try{await fs.lstat(path.join(dir,name));fail('PLATFORM_UNSUPPORTED');}catch(e){if(e.code!=='ENOENT')throw e;}
  await regular(path.join(dir,'config'));const config=await fs.readFile(path.join(dir,'config'),'utf8');
  if(/\[\s*include(?:if)?[\s."\]]|\bpartialclone\b|\bpromisor\b|\bworktreeconfig\b|\brefstorage\b|\bobjectformat\b|(?:^|\n)\s*worktree\s*=/i.test(config))fail('PLATFORM_UNSUPPORTED');
  for(const name of ['HEAD','packed-refs'])await regular(path.join(dir,name),{optional:true});
  return dir;
}
async function writeBlob(store,gitdir,bytes) {
  const frame=Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),oid=sha1(frame).toString('hex'),objects=path.join(gitdir,'objects'),prefix=path.join(objects,oid.slice(0,2));
  await directory(objects);try{await fs.mkdir(prefix,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}if((await directory(prefix)).dev!==store.lock.rootId.dev)fail('PLATFORM_UNSUPPORTED');await store.flush(objects);
  const target=path.join(prefix,oid.slice(2)),temporary=path.join(prefix,`tmp-project-files-${newId()}`);
  const f=await fs.open(temporary,'wx',0o600);await f.writeFile(deflateSync(frame));await f.close();await store.flush(temporary);
  try{await fs.link(temporary,target);}catch(e){if(e.code!=='EEXIST')throw e;await regular(target,{allowLinks:true});const existing=inflateSync(await fs.readFile(target),{maxOutputLength:frame.length+1});if(!existing.equals(frame))fail('GIT_CONFLICT');}
  await store.checkpoint('GIT_OBJECT_LINK');await fs.unlink(temporary);await store.flush(target);await store.flush(prefix);await store.checkpoint('GIT_OBJECT_DURABLE');return oid;
}
export function parseIndex(bytes) {
  if(bytes.length<32||bytes.subarray(0,4).toString()!=='DIRC'||!sha1(bytes.subarray(0,-20)).equals(bytes.subarray(-20)))fail('UNSUPPORTED_RESOLUTION_STATE');
  const version=bytes.readUInt32BE(4),count=bytes.readUInt32BE(8);if(![2,3].includes(version)||count>100000)fail('UNSUPPORTED_RESOLUTION_STATE');
  const entries=[];let offset=12;
  for(let n=0;n<count;n++){
    const start=offset;if(offset+62>bytes.length-20)fail('UNSUPPORTED_RESOLUTION_STATE');
    const flags=bytes.readUInt16BE(offset+60),extended=!!(flags&0x4000);if(extended)fail('UNSUPPORTED_RESOLUTION_STATE');
    const end=bytes.indexOf(0,offset+62);if(end<0||end>=bytes.length-20)fail('UNSUPPORTED_RESOLUTION_STATE');
    const name=bytes.subarray(offset+62,end).toString('utf8');if(Buffer.byteLength(name)!==end-offset-62)fail('UNSUPPORTED_RESOLUTION_STATE');
    offset=start+Math.ceil((end-start+1)/8)*8;
    entries.push({name,stage:(flags>>12)&3,mode:bytes.readUInt32BE(start+24),oid:bytes.subarray(start+40,start+60).toString('hex'),raw:bytes.subarray(start,offset)});
  }
  while(offset<bytes.length-20){if(offset+8>bytes.length-20)fail('UNSUPPORTED_RESOLUTION_STATE');const tag=bytes.subarray(offset,offset+4).toString(),size=bytes.readUInt32BE(offset+4);if(tag!=='TREE'||offset+8+size>bytes.length-20)fail('UNSUPPORTED_RESOLUTION_STATE');offset+=8+size;}
  if(offset!==bytes.length-20)fail('UNSUPPORTED_RESOLUTION_STATE');
  return {version,entries};
}
export function buildIndex(parsed,replacements) {
  const entries=parsed.entries.filter(e=>!replacements.has(e.name));
  for(const [name,{oid,size}] of replacements){const filename=Buffer.from(name);const raw=Buffer.alloc(Math.ceil((62+filename.length+1)/8)*8);raw.writeUInt32BE(0o100644,24);raw.writeUInt32BE(size,36);Buffer.from(oid,'hex').copy(raw,40);raw.writeUInt16BE(Math.min(filename.length,0xfff),60);filename.copy(raw,62);entries.push({name,stage:0,raw});}
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name),Buffer.from(b.name))||a.stage-b.stage);
  const header=Buffer.alloc(12);header.write('DIRC');header.writeUInt32BE(parsed.version,4);header.writeUInt32BE(entries.length,8);const data=Buffer.concat([header,...entries.map(e=>e.raw)]);return Buffer.concat([data,sha1(data)]);
}
export function gitRun(root,args,input) {
  const r=spawnSync('git',['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',root,...args],{input,encoding:null,env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
  if(r.error||r.status!==0)fail('GIT_CONFLICT');return r.stdout;
}
export async function indexPlan(store,after,paths) {
  await guardGitDirectory(store.root);
  if(gitRun(store.root,['rev-parse','--show-object-format']).toString().trim()!=='sha1')fail('UNSUPPORTED_RESOLUTION_STATE');
  const gitdir=gitRun(store.root,['rev-parse','--absolute-git-dir']).toString().trim();await directory(gitdir);
  // Linked worktrees and alternate index layouts require a separately verified adapter.
  if((await fs.lstat(path.join(store.root,'.git'))).isFile())fail('PLATFORM_UNSUPPORTED');
  const before=await fs.readFile(path.join(gitdir,'index')),parsed=parseIndex(before),replacements=new Map();
  for(const e of parsed.entries)if(e.stage&&!paths.includes(e.name))fail('UNSUPPORTED_RESOLUTION_STATE');
  for(const name of paths){
    const image=after.find(x=>x.path===name);if(!image?.exists)fail('UNSUPPORTED_RESOLUTION_STATE');
    const bytes=Buffer.from(image.bytes,'base64'),oid=await writeBlob(store,gitdir,bytes);
    if(!/^[0-9a-f]{40}$/.test(oid))fail('GIT_CONFLICT');replacements.set(name,{oid,size:bytes.length});
  }
  const bytes=buildIndex(parsed,replacements),seed=`project-files-seed-${newId()}`;
  const seedPath=path.join(gitdir,seed),f=await fs.open(seedPath,'wx',0o600);await f.writeFile(bytes);await f.close();await store.flush(seedPath);await store.flush(gitdir);await store.checkpoint('GIT_SEED_DURABLE');
  return {gitdir_identity:await identity(gitdir),seed,seed_identity:await identity(seedPath),before:before.toString('base64'),after:bytes.toString('base64'),before_digest:rawHash(before),after_digest:rawHash(bytes),paths};
}
async function indexFile(filename) {
  try{const st=await fs.lstat(filename);if(!st.isFile()||st.isSymbolicLink())fail('PATH_UNSAFE');return {identity:{dev:st.dev,ino:st.ino},digest:rawHash(await fs.readFile(filename))};}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function ownIndexLock(store,plan,{decided=false,abandon=false}={}) {
  await guardGitDirectory(store.root);
  const gitdir=gitRun(store.root,['rev-parse','--absolute-git-dir']).toString().trim();
  if(!sameIdentity(await identity(gitdir),plan.gitdir_identity)||!/^(project-files-seed-)[a-f0-9-]{36}$/.test(plan.seed))fail('GIT_CONFLICT');
  const seedPath=path.join(gitdir,plan.seed),seed=await indexFile(seedPath),lockPath=path.join(gitdir,'index.lock'),lock=await indexFile(lockPath),index=await indexFile(path.join(gitdir,'index'));
  if(!seed||!sameIdentity(seed.identity,plan.seed_identity)||seed.digest!==plan.after_digest)fail('JOURNAL_CORRUPT');
  if(lock&&(!sameIdentity(lock.identity,plan.seed_identity)||lock.digest!==plan.after_digest))fail('LOCK_UNAVAILABLE');
  if(index?.digest!==plan.before_digest&&index?.digest!==plan.after_digest)fail('GIT_CONFLICT');
  if(abandon){if(index.digest!==plan.before_digest)fail('GIT_CONFLICT');if(lock){await fs.unlink(lockPath);await store.flush(gitdir);}return;}
  if(decided&&index?.digest===plan.after_digest)return;
  if(!lock){await store.checkpoint('before-GIT_LINK');try{await fs.link(seedPath,lockPath);}catch(e){if(e.code==='EEXIST')fail('LOCK_UNAVAILABLE');throw e;}await store.checkpoint('GIT_LINK');await store.flush(gitdir);}
  if(!sameIdentity((await indexFile(lockPath)).identity,plan.seed_identity))fail('LOCK_UNAVAILABLE');
}
export async function publishIndex(store,plan) {
  await ownIndexLock(store,plan,{decided:true});
  const gitdir=gitRun(store.root,['rev-parse','--absolute-git-dir']).toString().trim(),index=await indexFile(path.join(gitdir,'index'));
  if(index.digest===plan.after_digest)return;
  await store.checkpoint('before-GIT_INDEX_RENAME');await guardGitDirectory(store.root);await fs.rename(path.join(gitdir,'index.lock'),path.join(gitdir,'index'));await store.checkpoint('GIT_INDEX_RENAME');await store.flush(gitdir);
}
