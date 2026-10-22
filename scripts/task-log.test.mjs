import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse,section,instant,summarize,evidenceTarget,displayEntries} from './task-log.mjs';
const event=(id,at)=>({id,at,actor:'经理',type:'verification',title:'检查结果',detail:'失败后保留证据',result:'failed',evidence:[{label:'依据',ref:'用户本轮指令'}]});
const card=events=>'# DEMO-001\n\n## 目标\n保留说明\n\n## 任务日志\n```yaml\n'+JSON.stringify({version:1,events},null,2)+'\n```\n\n## 附件\n保留附件\n';
test('structured timeline sorts actual instants descending and preserves description',()=>{
 const a=event('one','2026-10-14T10:00:00+08:00'),b=event('two','2026-10-14T03:00:00Z');
 const parsed=parse(card([b,a]));assert.deepEqual(parsed.errors,[]);assert.deepEqual(parsed.events.map(x=>x.id),['two','one']);assert.match(parsed.description,/保留说明/);assert.match(parsed.description,/保留附件/);assert.doesNotMatch(parsed.description,/version/);
});
test('standard YAML supports multiline details, stable equal-time order, and dated backfill',()=>{
 const md='## 任务日志\n```yaml\nversion: 1\nevents:\n  - id: first\n    at: "2026-10-14T10:00:00+08:00"\n    actor: 经理\n    type: checkpoint\n    title: 示例\n    detail: |\n      第一行\n      第二行\n    evidence:\n      - label: 依据\n        ref: 用户指令\n```';
 const p=parse(md);assert.deepEqual(p.errors,[]);assert.match(p.events[0].detail,/第一行\n第二行/);
 const one=event('1','2026-10-14T10:00:00Z'),two=event('2',one.at),three={...event('3',null),recorded_at:'2026-10-14T11:00:00Z'};
 assert.deepEqual(parse(card([one,two,three])).events.map(x=>x.id),['3','2','1']);
});
test('malformed YAML, duplicate IDs/keys, missing evidence, invalid date and event types are rejected',()=>{
 for(const events of [[event('1','2026-02-30T10:00:00Z')],[event('1','2026-10-14T10:00:00')],[{...event('1',null)}],[{...event('1','2026-10-14T10:00:00Z'),evidence:[]}],[{...event('1','2026-10-14T10:00:00Z'),type:'constructor'}],[event('1','2026-10-14T10:00:00Z'),event('1','2026-10-14T10:00:00Z')]])assert.ok(parse(card(events)).errors.length);
 assert.ok(parse('## 任务日志\n```yaml\nversion: [\n```').errors.length);
 assert.ok(parse('## 任务日志\n```yaml\nversion: 1\nversion: 1\nevents: []\n```').errors.length);
 assert.ok(Number.isNaN(instant('2026-13-01T00:00:00Z')));
});
test('legacy original text retained, fenced example headings ignored, invalid structured log never becomes valid legacy',()=>{
 const legacy='## 任务日志\n- 2026-10-14T10:00:00Z｜经理｜创建｜测试依据';assert.equal(parse(legacy).legacy.trim(),legacy.split('\n')[1]);
 assert.equal(section('```md\n## 任务日志\n```\n'+legacy).count,1);
 assert.equal(parse('## 任务日志\n```yaml\nversion: 1\nevents: []\n```').mode,'structured');assert.ok(parse('## 任务日志\n```yaml\nversion: 1\nevents: []\n```').errors.length);
});

test('legacy entries cannot mask an unclosed YAML block; longer valid closing fences work',()=>{
 const legacy='## 任务日志\n- 2026-10-14T10:00:00Z｜经理｜创建｜真实依据\n';
 const broken=parse(legacy+'```yaml\nversion: broken\nevents: []');assert.equal(broken.mode,'structured');assert.ok(broken.errors.length);
 const good=card([event('valid','2026-10-14T10:00:00Z')]).replace('\n```\n\n## 附件','\n````\n\n## 附件');assert.deepEqual(parse(good).errors,[]);assert.equal(parse(good).events.length,1);
 const second=card([event('valid','2026-10-14T10:00:00Z')]).split('## 附件')[0]+'```yaml\nversion: broken';assert.ok(parse(second).errors.length);assert.equal(parse(second).mode,'structured');
});

test('compact summaries preserve source and backfills group only identical unknown-time batches',()=>{
 const detail='这次记录的新增事实。'+ '完整旧报告与参数'.repeat(80),summary=summarize(detail);assert.equal(summary.text,'这次记录的新增事实。');assert.equal(summary.truncated,true);assert.equal(detail.length>120,true);
 const at='2026-10-14T10:42:31+08:00';const history=Array.from({length:68},(_,i)=>({...event('history-'+i,null),recorded_at:at}));
 const known={...event('current','2026-10-14T10:43:00+08:00')},other={...event('other',null),recorded_at:'2026-10-13T10:00:00Z'};
 const parsed=parse(card([other,...history,known]));const entries=displayEntries(parsed.events);
 assert.equal(parsed.errors.length,0);assert.equal(entries.length,3);assert.equal(entries[0].event.id,'current');assert.equal(entries[1].kind,'backfill');assert.equal(entries[1].events.length,68);assert.equal(entries[2].kind,'event');assert.equal(parsed.events.length,70);
});
test('evidence paths resolve from project root, legacy annotations are text, unsafe and prose refs are not links',()=>{
 const root='http://127.0.0.1:10000/projects/p/',base=root+'tasks/DEMO-050.md';
 assert.equal(evidenceTarget('tasks/DEMO-050.md',base,root).url,base);
 const old=evidenceTarget('tasks/DEMO-050.md 补记前第660行：原章节；恢复点example-revision',base,root);assert.equal(old.url,base);assert.match(old.note,/第660行/);assert.ok(!old.url.includes('tasks/tasks'));
 assert.equal(evidenceTarget('../docs/说明.md',base,root).url,new URL('docs/说明.md',root).href);
 assert.equal(evidenceTarget('evidence/My Report.md',base,root).url,new URL('evidence/My Report.md',root).href);
 assert.equal(evidenceTarget('https://example.com/report#proof',base,root).url,'https://example.com/report#proof');
 for(const ref of ['用户本轮要求','javascript:alert(1)','data:text/html,1','//evil.example/a.md','tasks/DEMO-050.md 这是说明'])assert.equal(evidenceTarget(ref,base,root).url,null);
});
test('optional evidence note is accepted without forcing explanations into a path',()=>{
 const e=event('note','2026-10-14T10:00:00Z');e.evidence=[{label:'原卡',ref:'tasks/DEMO-050.md',note:'补记前第660行，恢复点example-revision'}];assert.equal(parse(card([e])).errors.length,0);
});
test('活动起止时间成对校验，支持进行中、秒级时刻并拒绝负时长',()=>{
 const activity={...event('activity','2026-10-14T10:02:05Z'),started_at:'2026-10-14T10:00:35Z',ended_at:'2026-10-14T10:02:05Z'};
 assert.deepEqual(parse(card([activity])).errors,[]);
 assert.deepEqual(parse(card([{...activity,ended_at:null}])).errors,[]);
 for(const change of [{ended_at:undefined},{started_at:undefined},{ended_at:'2026-10-14T09:00:00Z'},{started_at:'bad'}])assert.ok(parse(card([{...activity,...change}])).errors.length);
});
test('CLI entry detection works through a symlinked invocation path and direct calls are unchanged',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'project-manager-task-log-'));
 try{
  const entry=fileURLToPath(new URL('./task-log.mjs',import.meta.url)),alias=path.join(directory,'task-log-alias.mjs');
  await symlink(entry,alias);
  const input=JSON.stringify([card([event('cli','2026-10-14T10:00:00Z')])]);
  const invoke=file=>execFileSync(process.execPath,[file],{input,encoding:'utf8'});
  const direct=invoke(entry),linked=invoke(alias);
  assert.equal(linked,direct);
  const parsed=JSON.parse(linked);
  assert.equal(parsed.length,1);assert.equal(parsed[0].mode,'structured');assert.deepEqual(parsed[0].errors,[]);assert.equal(parsed[0].events.length,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
