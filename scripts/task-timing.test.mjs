import test from 'node:test';
import assert from 'node:assert/strict';
import {timing,formatDuration} from './task-log.mjs';
const at=h=>`2026-10-14T${String(h).padStart(2,'0')}:00:00Z`;
const task=status=>({created_at:at(0),status});
const event=(h,to,extra={})=>({id:'e'+h,at:at(h),state_to:to,order:h,...extra});
const log=events=>({mode:'structured',errors:[],events,legacy:''});
const hour=3600000;
test('执行累计支持受阻、待确认、暂停、重开；终结后停止计时，分布守恒',()=>{
 const events=[event(0,'待办'),event(1,'进行中'),event(3,'受阻'),event(4,'进行中'),event(5,undefined,{type:'paused'}),event(6,'进行中'),event(7,'待确认'),event(8,'已完成'),event(9,'进行中'),event(10,'已完成')];
 const data=timing(task('已完成'),log(events),Date.parse(at(12)));
 assert.equal(data.executionMs,5*hour);assert.equal(data.totals['暂停'],hour);assert.equal(data.totals['受阻'],hour);assert.equal(data.totals['待确认'],hour);
 assert.equal(Object.values(data.totals).reduce((a,b)=>a+b),10*hour);assert.equal(data.complete,true);assert.equal(data.live,false);
});
test('实时进行中按当前时刻增长，按真实时刻排序并处理时区',()=>{
 const events=[event(2,'进行中'),event(0,'待办')];events[0].at='2026-10-14T10:00:00+08:00';
 assert.equal(timing(task('进行中'),log(events),Date.parse(at(5))).executionMs,3*hour);
});
test('未知时间不能当作补记时间；格式错误、历史原文及无状态不伪装成零',()=>{
 const unknown=event(2,'进行中',{at:null,recorded_at:at(2)});
 assert.equal(timing(task('进行中'),log([unknown]),Date.parse(at(5))).available,false);
 assert.equal(timing(task('进行中'),{...log([]),errors:['bad']}).executionMs,null);
 assert.equal(timing(task('进行中'),{...log([]),mode:'legacy'}).executionMs,null);
 const partial=timing(task('进行中'),log([event(2,'进行中'),unknown]),Date.parse(at(5)));
 assert.equal(partial.available,false);assert.equal(partial.executionMs,null);
});
test('CSV状态冲突的尾段、缺失状态变化不算执行时间；更正排除被替代记录',()=>{
 const data=timing(task('受阻'),log([event(0,'进行中'),event(2,'进行中',{state_from:'待确认'})]),Date.parse(at(5)));
 assert.equal(data.executionMs,0);assert.equal(data.totals['未知'],5*hour);
 const fixed=timing(task('进行中'),log([event(0,'待办'),event(1,'进行中'),event(2,'进行中',{supersedes:'e1'})]),Date.parse(at(5)));
 assert.equal(fixed.executionMs,3*hour);
});
test('无效创建时间、未来边界、重复同状态、同刻边界及零时长',()=>{
 assert.equal(timing({...task('待办'),created_at:'bad'},log([])).available,false);
 const data=timing(task('进行中'),log([event(0,'待办'),event(1,'进行中'),event(2,'进行中'),event(9,'受阻')]),Date.parse(at(5)));
 assert.equal(data.executionMs,4*hour);assert.equal(data.complete,false);
 assert.equal(formatDuration(90061000),'1天 1小时 1分 1秒');assert.equal(formatDuration(0),'0秒');
});

test('活动时间线使用显式起止时间，按分秒排列，缺口单列而非推算活动',async()=>{
 const {activityTimeline,offsetTime}=await import('./task-log.mjs');
 const origin=Date.parse(at(1)),activity=(id,start,end)=>({id,title:id,started_at:new Date(origin+start*1000).toISOString(),ended_at:end===null?null:new Date(origin+end*1000).toISOString()});
 const data=activityTimeline(task('进行中'),log([activity('代码修改',35,125),activity('分析需求',0,35),activity('验证',150,null)]),origin+200000);
 assert.deepEqual(data.rows.map(r=>r.title),['分析需求','代码修改','这段时间未记录活动','验证']);
 assert.equal(offsetTime(data.rows[1].end-data.origin),'02:05');assert.equal(data.rows.at(-1).ongoing,true);
 assert.equal(data.rows[2].end-data.rows[2].start,25000);
 const points=activityTimeline(task('进行中'),log([event(1,'进行中')]),Date.parse(at(2)));
 assert.equal(points.rows.length,0);assert.equal(points.points.length,1);assert.equal(points.points[0].offset,0);
});
test('并行活动保留重叠、更正排除旧活动、终结任务不延长未关闭活动',async()=>{
 const {activityTimeline}=await import('./task-log.mjs');
 const activities=[{id:'old',started_at:at(0),ended_at:at(1),title:'旧记录'},{id:'fix',supersedes:'old',started_at:at(0),ended_at:at(2),title:'修正记录'},{id:'parallel',started_at:at(1),ended_at:at(3),title:'并行验证'}];
 const data=activityTimeline(task('已完成'),log(activities),Date.parse(at(4)));
 assert.equal(data.rows.length,2);assert.equal(data.rows[1].overlaps,true);
 assert.equal(activityTimeline(task('已完成'),log([{started_at:at(1),ended_at:null}]),Date.parse(at(4))).rows.length,0);
});
test('图形位置和长度按绝对时间比例计算，点事件与并行区段可同时展示',async()=>{
 const {activityGraphModel,absoluteTime}=await import('./task-log.mjs');
 const start=Date.parse(at(1));
 const graph=activityGraphModel({rows:[{id:'a',start,end:start+60000},{id:'b',start:start+30000,end:start+120000}],points:[{id:'point',at:at(1)}]});
 assert.equal(graph.rows.length,3);assert.equal(graph.ticks.length,5);
 const a=graph.rows.find(r=>r.id==='a'),b=graph.rows.find(r=>r.id==='b');
 assert.equal(a.barWidth,414);assert.equal(b.x,243);assert.equal(graph.rows.find(r=>r.point).barWidth,3);
 assert.match(absoluteTime(start),/^2026-10-14 \d\d:00:00$/);
});
