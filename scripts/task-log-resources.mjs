// Only explicit references in registered task logs grant read access; never crawl directories.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';
import { parse, evidenceTarget } from './task-log.mjs';
import { readRepositoryFile } from './testing-dashboard.mjs';

export function logEvidencePath(ref, detailPath) {
  if(path.isAbsolute(ref))return null;
  const root='http://task-log.invalid/';
  const target=evidenceTarget(ref,new URL(detailPath.split('/').map(encodeURIComponent).join('/'),root).href,root);
  if(!target.url)return null;
  try {
    const url=new URL(target.url);
    if(url.origin!==new URL(root).origin)return null;
    const relative=decodeURIComponent(url.pathname.slice(1));
    if(!relative||relative.includes('\\')||relative.split('/').some(x=>!x||x.startsWith('.')||x==='node_modules'))return null;
    return relative;
  }catch{return null;}
}
export async function taskLogResources(repository, rows) {
  const allowed=new Set(),directories=new Set(),column=(rows[0]||[]).indexOf('detail_path');
  if(column<0)return {allowed,directories};
  const root=await realpath(repository);
  for(const row of rows.slice(1)) {
    try {
      const parsed=parse(await readRepositoryFile(repository,row[column],'utf8'));
      if(parsed.errors.length)continue;
      for(const event of parsed.events)for(const evidence of event.evidence){
        const relative=logEvidencePath(evidence.ref,row[column]);
        if(!relative||allowed.has(relative))continue;
        try {
          const canonical=await realpath(path.join(root,relative));
          if(!canonical.startsWith(root+path.sep)||path.relative(root,canonical).split(path.sep).some(x=>x.startsWith('.'))||!(await stat(canonical)).isFile())continue;
          allowed.add(relative);directories.add(path.dirname(path.join(repository,relative)));
        }catch{/* Missing or unsafe references grant nothing. */}
      }
    }catch{/* Invalid/unreadable cards grant nothing. */}
  }
  return {allowed,directories};
}

// Absolute paths are resolved only after proving this exact reference occurs in this registered card.
export async function readAbsoluteLogEvidence(repository, rows, card, ref) {
  const col=(rows[0]||[]).indexOf('detail_path');
  const denied=()=>Object.assign(new Error('依据未登记或不在允许范围内'),{code:'EACCES'});
  if(col<0||!rows.slice(1).some(row=>row[col]===card)||typeof ref!=='string')throw denied();
  const parsed=parse(await readRepositoryFile(repository,card,'utf8'));
  if(parsed.errors.length||!parsed.events.some(e=>e.evidence.some(x=>x.ref===ref)))throw denied();
  const value=ref.replace(/\s+补记前第\d+行[：:][\s\S]*$/,'').trim();
  if(!path.isAbsolute(value)||/[\\\r\n]/.test(value))throw denied();
  const root=await realpath(repository),skill=await realpath(fileURLToPath(new URL('..',import.meta.url)));
  const canonical=await realpath(value);
  let owner,relative;
  if(canonical.startsWith(root+path.sep)){owner=root;relative=path.relative(root,canonical);}
  else if(canonical.startsWith(path.join(skill,'references')+path.sep)&&canonical.endsWith('.md')){owner=skill;relative=path.relative(skill,canonical);}
  else throw denied();
  if(relative.split(path.sep).some(x=>x.startsWith('.'))||!logEvidencePath(relative,card))throw denied();
  const types={'.md':'text/markdown; charset=utf-8','.txt':'text/plain; charset=utf-8','.log':'text/plain; charset=utf-8','.json':'application/json','.jsonl':'application/x-ndjson','.csv':'text/csv; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm'};
  const contentType=types[path.extname(relative).toLowerCase()]||'application/octet-stream';
  return {relative,contentType,body:await readRepositoryFile(owner,relative)};
}
