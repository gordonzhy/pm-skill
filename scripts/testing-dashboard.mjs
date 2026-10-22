import path from 'node:path';
import { realpath, open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
// Check canonical path before opening/reading, then bind the read to that handle.
export async function readRepositoryFile(repository, relative, encoding) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(x=>!x||x==='.'||x==='..')) throw Object.assign(new Error('unsafe dashboard path'), {code:'EACCES'});
  const root=await realpath(repository), original=path.join(root,relative), canonical=await realpath(original);
  if (!canonical.startsWith(root+path.sep) || (relative.startsWith('evidence/') && !canonical.startsWith(path.join(root,'evidence')+path.sep))) throw Object.assign(new Error('outside repository'),{code:'EACCES'});
  const handle=await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual=await handle.stat(), current=await realpath(original);
    if (!current.startsWith(root+path.sep) || (relative.startsWith('evidence/') && !current.startsWith(path.join(root,'evidence')+path.sep))) throw Object.assign(new Error('outside repository'),{code:'EACCES'});
    const expected=await stat(current);
    if (!actual.isFile() || actual.dev!==expected.dev || actual.ino!==expected.ino) throw Object.assign(new Error('dashboard path changed'),{code:'EACCES'});
    return await handle.readFile(encoding);
  } finally { await handle.close(); }
}
export async function testingResources(repository, tasks, parseCsv) {
  const allowed=new Set(), directories=new Set();
  const headers=tasks[0]||[], type=headers.indexOf('task_type'), detail=headers.indexOf('detail_path');
  if(type<0||detail<0) return {allowed,directories};
  const safe=async value=>{
    if(typeof value!=='string'||!value.startsWith('evidence/')||value.split('/').some(x=>!x||x==='.'||x==='..')||value.includes('\\')||!(/\.(jsonl?|csv|md|png|jpg|jpeg|webp|webm|mp4|txt|log)$/.test(value))) return false;
    try {const resolved=await realpath(path.resolve(repository,value));return resolved.startsWith(path.join(await realpath(repository),'evidence')+path.sep);} catch{return false;}
  };
  for(const row of tasks.slice(1).filter(x=>x[type]==='测试')) {
    try {
      const detailPath=path.resolve(repository,row[detail]);
      if(!detailPath.startsWith(repository+path.sep)) continue;
      const text=await readRepositoryFile(repository,row[detail],'utf8');
      const specPath=text.match(/^- 测试清单：(.+)$/m)?.[1]?.trim();
      if(!await safe(specPath)) continue;
      allowed.add(specPath);directories.add(path.dirname(detailPath));
      const spec=JSON.parse(await readRepositoryFile(repository,specPath,'utf8'));
      for(const key of ['report','scenarios','issues','runs']) if(await safe(spec[key])) allowed.add(spec[key]);
      // Attachments are explicit in issue/run evidence, never a whole directory grant.
      if(await safe(spec.issues)) {
        const rows=parseCsv(await readRepositoryFile(repository,spec.issues,'utf8'));
        const col=rows[0]?.indexOf('evidence');
        if(col>=0) for(const row of rows.slice(1)) for(const file of (row[col]||'').split(';')) if(await safe(file)) allowed.add(file);
      }
      if(await safe(spec.runs)) for(const line of (await readRepositoryFile(repository,spec.runs,'utf8')).split('\n').filter(Boolean)) {
        const run=JSON.parse(line);
        for(const result of Object.values(run.issue_results||{})) for(const file of result.evidence||[]) if(await safe(file)) allowed.add(file);
      }
    } catch { /* Missing/invalid suite stays unavailable, never zero/passed. */ }
  }
  for(const file of allowed) directories.add(path.dirname(path.join(repository,file)));
  return {allowed,directories};
}
