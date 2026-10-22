// Local POSIX adapter. The helper owns the kernel lock and performs strict flushes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fail } from './contracts.mjs';

const helper = String.raw`
import fcntl,json,os,stat,sys,time
filename,mode=sys.argv[1:]
try:
 # Inherited from Node: both processes retain the same open-file description.
 fd=3
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_uid!=os.getuid() or st.st_mode&0o077: raise ValueError()
 deadline=time.monotonic()+10
 while True:
  try: fcntl.flock(fd,(fcntl.LOCK_SH if mode=='read' else fcntl.LOCK_EX)|fcntl.LOCK_NB);break
  except BlockingIOError:
   if time.monotonic()>deadline: raise TimeoutError()
   time.sleep(.01)
 print(json.dumps({'ready':True,'dev':st.st_dev,'ino':st.st_ino}),flush=True)
 for line in sys.stdin:
  try:
   q=json.loads(line)
   if q['op']=='rename-exclusive':
    import ctypes
    lib=ctypes.CDLL(None,use_errno=True)
    if lib.renamex_np(os.fsencode(q['source']),os.fsencode(q['path']),4)!=0: raise OSError(ctypes.get_errno(),'rename failed')
   if q['op']=='flush':
    f=os.open(q['path'],os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    try:
     os.fsync(f)
     if sys.platform=='darwin' and stat.S_ISREG(os.fstat(f).st_mode):fcntl.fcntl(f,51)
    finally:os.close(f)
   print(json.dumps({'ok':True}),flush=True)
  except Exception: print(json.dumps({'ok':False}),flush=True)
except Exception:
 print(json.dumps({'ready':False}),flush=True);sys.exit(1)
`;

export async function identity(filename) {
  const st=await fs.lstat(filename);
  if(st.isSymbolicLink())fail('PATH_UNSAFE');
  if(!Number.isSafeInteger(st.dev)||!Number.isSafeInteger(st.ino)||st.ino<=0)fail('PLATFORM_UNSUPPORTED');
  return {dev:st.dev,ino:st.ino};
}
export const sameIdentity=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
export async function regular(filename,{optional=false,allowLinks=false}={}) {
  try {const st=await fs.lstat(filename);if(!st.isFile()||st.isSymbolicLink()||(!allowLinks&&st.nlink!==1))fail('PATH_UNSAFE');return st;}
  catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}
}
export async function directory(filename) {
  const st=await fs.lstat(filename);
  if(!st.isDirectory()||st.isSymbolicLink())fail('PATH_UNSAFE');
  return st;
}
export async function safeRoot(root) {
  if(!path.isAbsolute(root))fail('PATH_UNSAFE');
  let canonical;try{canonical=await fs.realpath(root);}catch(e){if(e.code==='ENOENT')fail('RECOVERY_REQUIRED');if(e.code==='EACCES')fail('AUTH_DENIED');throw e;}
  // Canonicalise parent aliases; the supplied checkout itself must be a real directory.
  await directory(root);
  const st=await directory(canonical);
  if(st.uid!==process.getuid?.()||(st.mode&0o022))fail('AUTH_DENIED');
  return canonical;
}
export function stateRoot() {
  return path.join(os.homedir(),'.local','state','project-files');
}
export function lockFilename(rootId,state=stateRoot()) {return path.join(state,`${createHash('sha256').update(JSON.stringify(rootId)).digest('hex')}.lock`);}
export async function openLock(root,{mode='write',create=false,state=stateRoot()}={}) {
  if(!['darwin','linux'].includes(process.platform)||!process.getuid)fail('PLATFORM_UNSUPPORTED');
  root=await safeRoot(root);
  const rootId=await identity(root);
  const filename=lockFilename(rootId,state);
  if(create) {
    await fs.mkdir(state,{recursive:true,mode:0o700});
    const st=await directory(state);
    if(st.uid!==process.getuid()||(st.mode&0o077))fail('AUTH_DENIED');
    if(process.platform==='darwin'&&(await fs.statfs(state)).type!==26)fail('PLATFORM_UNSUPPORTED');
    const fd=await fs.open(filename,'wx',0o600).catch(e=>{if(e.code==='EEXIST')return null;throw e;});
    if(fd){await fd.sync();await fd.close();const d=await fs.open(state,'r');await d.sync();await d.close();}
  }
  if(process.platform==='darwin')try{if((await fs.statfs(state)).type!==26)fail('PLATFORM_UNSUPPORTED');}catch(e){if(e.code==='ENOENT')fail('RECOVERY_REQUIRED');throw e;}
  // Query never creates the state directory or a lock inode.
  try {await regular(filename);}catch(e){if(e.code==='ENOENT')fail('RECOVERY_REQUIRED');throw e;}
  // Keep Node's duplicate open until all writes are finished. Helper death alone
  // cannot release this flock; the helper never explicitly unlocks it.
  const owner=await fs.open(filename,constants.O_RDWR|constants.O_NOFOLLOW);
  const child=spawn('python3',['-u','-c',helper,filename,mode],{stdio:['pipe','pipe','ignore',owner.fd]});
  let buffer='',waiting=[],alive=true,releasing=false;
  const closed=new Promise(resolve=>child.once('close',resolve));
  const rejectAll=()=>{alive=false;for(const w of waiting.splice(0))w.reject(new Error('lock helper unavailable'));};
  child.on('error',rejectAll);
  child.on('exit',()=>{rejectAll();if(!releasing&&ready)process.exit(25);});
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const n=buffer.indexOf('\n');if(n<0)break;const line=buffer.slice(0,n);buffer=buffer.slice(n+1);const w=waiting.shift();if(w){try{w.resolve(JSON.parse(line));}catch{w.reject(new Error('lock protocol'));}}}});
  const receive=()=>new Promise((resolve,reject)=>{if(!alive)reject(new Error('lock helper unavailable'));else waiting.push({resolve,reject});});
  let ready=false;
  const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  let hello;
  try {hello=await receive();}catch{releasing=true;child.kill('SIGKILL');await closed;await owner.close();fail('LOCK_UNAVAILABLE');}finally{clearTimeout(timer);}
  if(!hello.ready){releasing=true;child.stdin.end();await closed;await owner.close();fail('LOCK_UNAVAILABLE');}
  ready=true;
  return {root,rootId,filename,pid:child.pid,lockId:{dev:hello.dev,ino:hello.ino},
    async assert(){if(!alive||!sameIdentity(await identity(filename),hello)||!sameIdentity(await identity(root),rootId))fail('LOCK_UNAVAILABLE');},
    async renameExclusive(source,filename){await this.assert();const response=receive();child.stdin.write(`${JSON.stringify({op:'rename-exclusive',source,path:filename})}\n`);if(!(await response).ok)throw new Error('exclusive rename failed');},
    async flush(filename){await this.assert();const response=receive();child.stdin.write(`${JSON.stringify({op:'flush',path:filename})}\n`);if(!(await response).ok)throw new Error('durability IO failed');},
    async release(){releasing=true;child.stdin.end();await closed;await owner.close();},
  };
}
