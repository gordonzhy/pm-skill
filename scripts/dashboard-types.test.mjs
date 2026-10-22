import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../assets/task-dashboard.html',import.meta.url),'utf8');
function functionCode(name){const start=source.indexOf(`function ${name}(`);assert(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
function context(){
 class Element {constructor(name){this.name=name;this.attributes={};this.children=[];this.style={};}setAttribute(k,v){this.attributes[k]=v;}append(...nodes){this.children.push(...nodes);}replaceChildren(){this.children=[];}}
 const svg=new Element('svg');const c=vm.createContext({document:{getElementById:()=>svg,createElementNS:(_ns,name)=>new Element(name)},collator:new Intl.Collator('zh-CN'),taskTypes:['需求','设计','开发','测试','部署','管理'],tasks:[],taskById:new Map(),controls:Array.from({length:9},()=>({value:''})),graphBaseWidth:0,graphBaseHeight:0,applyDependencyGraphZoom:()=>{}});
 for(const name of ['parseCsv','parseDependencies','executionFor','tasksFromCsv','filteredTasks','dependencyLayers','svgElement','renderDependencyGraph'])vm.runInContext(functionCode(name),c);
 // The one-line function is bounded differently.
 vm.runInContext(source.match(/^function typeKey[^\n]+/m)[0],c);
 return {c,svg};
}
test('legacy tasks remain unclassified and explicit test type filters independently of status',()=>{
 const {c}=context();const header='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path';const row='QA-001,待办,P1,QA,体验,[],tester,2026-10-09T00:00:00Z,2026-10-09T00:00:00Z,tasks/QA-001.md';
 assert.equal(c.tasksFromCsv(header+'\n'+row+'\n')[0].task_type,'未分类');c.tasks=c.tasksFromCsv(header+',task_type\n'+row+',测试\n');c.controls[8].value='测试';assert.equal(c.filteredTasks().length,1);c.controls[8].value='开发';assert.equal(c.filteredTasks().length,0);assert.equal(c.tasks[0].status,'待办');
});
test('graph type labels keep dependency edge and dim non-selected nodes',()=>{
 const {c,svg}=context();const tasks=[{task_id:'DEV-001',task_type:'开发',dependencies:[],execution:'completed',title:'开发'},{task_id:'QA-001',task_type:'测试',dependencies:['DEV-001'],execution:'ready',title:'测试'}];c.taskById=new Map(tasks.map(t=>[t.task_id,t]));c.renderDependencyGraph(tasks,new Set(['QA-001']));
 const groups=svg.children.filter(x=>x.name==='g');assert.equal(groups.length,2);assert(groups[0].attributes.class.includes('graph-muted'));assert(!groups[1].attributes.class.includes('graph-muted'));assert.equal(groups[1].children.at(-1).textContent,'测试');assert(svg.children.some(x=>x.attributes.class==='graph-edge'));
});
