/* Structured task logs, shared by browser, collector and validation bridge. */
(() => {
  const labels = {created:'创建',requirement_changed:'需求变更',dispatched:'派发',checkpoint:'检查点',verification:'验证',blocked:'阻碍',paused:'暂停',resumed:'恢复',decision_requested:'请求决策',decision:'用户决定',accepted:'验收',reopened:'重开',closed:'关闭',cancelled:'取消',route_changed:'路由变更',corrected:'记录更正'};
  const keys = new Set(['id','at','recorded_at','actor','type','title','detail','impact','evidence','result','state_from','state_to','route_from','route_to','supersedes','started_at','ended_at']);
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  function instant(value) {
    if(typeof value!=='string')return NaN;
    const m=value.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/);
    if(!m)return NaN;
    const [,y,mo,d,h,mi,s,tz]=m, date=new Date(`${y}-${mo}-${d}T00:00:00Z`);
    if(!Number.isFinite(+date)||date.getUTCFullYear()!==+y||date.getUTCMonth()+1!==+mo||date.getUTCDate()!==+d||+h>23||+mi>59||+s>59||(tz!=='Z'&&(+tz.slice(1,3)>23||+tz.slice(4)>59)))return NaN;
    return Date.parse(value);
  }
  function section(markdown) {
    const lines=markdown.split(/\r?\n/);let fence=null,start=-1,end=lines.length,count=0;
    for(let i=0;i<lines.length;i++) {
      const line=lines[i],f=line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if(f){if(!fence)fence=f[1];else if(f[1][0]===fence[0]&&f[1].length>=fence.length&&/^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line))fence=null;continue;}
      if(fence)continue;
      if(/^##\s+任务日志\s*#*\s*$/.test(line)){count++;if(start<0)start=i;}
      else if(start>=0&&end===lines.length&&/^#{1,2}\s/.test(line))end=i;
    }
    return {count,body:start<0?'':lines.slice(start+1,end).join('\n'),description:start<0?markdown:[...lines.slice(0,start),...lines.slice(end)].join('\n')};
  }
  function parse(markdown) {
    const part=section(markdown),errors=[],events=[];const fail=m=>errors.push(m);
    if(part.count!==1){if(part.count>1)fail('任务日志章节重复');return {...part,mode:'legacy',events,errors,legacy:part.body};}
    const blocks=[],lines=part.body.split('\n');let fence=null,language='',start=0;
    for(let i=0;i<lines.length;i++){
      const open=lines[i].match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if(!fence&&open){fence=open[1];language=open[2].trim().split(/\s/)[0].toLowerCase();start=i;continue;}
      if(fence&&open&&open[1][0]===fence[0]&&open[1].length>=fence.length&&!open[2].trim()){
        if(['yaml','yml'].includes(language))blocks.push([lines.slice(start,i+1).join('\n'),fence,language,lines.slice(start+1,i).join('\n')]);fence=null;
      }
    }
    if(fence&&['yaml','yml'].includes(language))fail('YAML日志块未正确闭合');
    if(!blocks.length)return {...part,mode:errors.length?'structured':'legacy',events,errors,legacy:part.body};
    if(blocks.length!==1)fail('任务日志必须只有一个YAML日志块');
    let data;
    try {data=globalThis.jsyaml.load(blocks[0][3],{schema:globalThis.jsyaml.JSON_SCHEMA});}catch(e){fail('YAML解析失败：'+e.message);return {...part,mode:'structured',events,errors,legacy:''};}
    if(!object(data)||data.version!==1||!Array.isArray(data.events)||!data.events.length){fail('需要version: 1及非空events数组');return {...part,mode:'structured',events,errors,legacy:''};}
    if(Object.keys(data).some(k=>!['version','events'].includes(k)))fail('日志顶层含未知字段');
    if(data.events.length>10000){fail('日志超过10000条，请按任务契约归档后处理');return {...part,mode:'structured',events,errors,legacy:''};}
    const ids=new Set();
    for(const [index,e] of data.events.entries()) {
      const prefix=`事件${index+1}：`,before=errors.length;
      if(!object(e)){fail(prefix+'必须为对象');continue;}
      if(Object.keys(e).some(k=>!keys.has(k)))fail(prefix+'存在未知字段');
      for(const k of ['id','actor','type','title','detail'])if(typeof e[k]!=='string'||!e[k].trim())fail(prefix+k+'必须为非空文字');
      for(const k of ['title','detail'])if(typeof e[k]==='string'&&/^(TODO|TBD|待补充|待填写|待记录|暂无|无|事件|内容|结果|证据|依据)[。.!！\s]*$/i.test(e[k].trim()))fail(prefix+k+'不能为占位内容');
      if(typeof e.id==='string'&&ids.has(e.id))fail(prefix+'id重复');ids.add(e.id);
      if(!Object.hasOwn(labels,e.type))fail(prefix+'事件类型无效');
      if(!Number.isFinite(instant(e.at))&&e.at!==null)fail(prefix+'at必须是带秒和时区的有效时间，未知时填null');
      if(e.at===null&&!Number.isFinite(instant(e.recorded_at)))fail(prefix+'未知发生时间必须提供recorded_at补记时间');
      if(e.recorded_at!==undefined&&!Number.isFinite(instant(e.recorded_at)))fail(prefix+'recorded_at无效');
      if(e.started_at!==undefined||e.ended_at!==undefined){
        if(!Number.isFinite(instant(e.started_at)))fail(prefix+'started_at必须是带秒和时区的有效时间');
        if(e.ended_at!==null&&!Number.isFinite(instant(e.ended_at)))fail(prefix+'ended_at必须是有效时间，尚未结束填null');
        if(Number.isFinite(instant(e.started_at))&&Number.isFinite(instant(e.ended_at))&&instant(e.ended_at)<instant(e.started_at))fail(prefix+'活动结束时间不能早于开始时间');
      }
      for(const k of ['impact','state_from','state_to','route_from','route_to','supersedes'])if(e[k]!==undefined&&(typeof e[k]!=='string'||!e[k].trim()))fail(prefix+k+'必须为非空文字');
      if(e.result!==undefined&&!['passed','failed','partial','not_run'].includes(e.result))fail(prefix+'result无效');
      if(!Array.isArray(e.evidence)||!e.evidence.length||e.evidence.some(x=>!object(x)||Object.keys(x).some(k=>!['label','ref','note'].includes(k))||typeof x.label!=='string'||!x.label.trim()||typeof x.ref!=='string'||!x.ref.trim()||(x.note!==undefined&&(typeof x.note!=='string'||!x.note.trim()))))fail(prefix+'evidence需含非空label/ref依据');
      if(errors.length===before)events.push({...e,order:index,time:instant(e.at??e.recorded_at)});
    }
    for(const e of events)if(e.supersedes&&(!ids.has(e.supersedes)||e.supersedes===e.id))fail(`事件${e.id}：supersedes必须关联其他已有记录`);
    events.sort((a,b)=>b.time-a.time||b.order-a.order);
    const legacy=part.body.replace(blocks[0][0],'').trim();
    return {...part,mode:'structured',events,errors,legacy};
  }
  const taskStates=['待办','进行中','待确认','受阻','已完成','已取消'];
  function formatDuration(ms) {
    let seconds=Math.max(0,Math.floor(ms/1000));
    const days=Math.floor(seconds/86400);seconds%=86400;
    const hours=Math.floor(seconds/3600);seconds%=3600;
    const minutes=Math.floor(seconds/60);seconds%=60;
    return `${days?days+'天 ':''}${hours?hours+'小时 ':''}${minutes?minutes+'分 ':''}${seconds}秒`;
  }
  // Only explicit state boundaries count. Event titles and recorded_at are never clocks.
  function timing(task,parsed,now=Date.now()) {
    const start=instant(task.created_at),issues=[],segments=[];
    const unavailable=reason=>({available:false,issues:[reason],segments:[],totals:{},executionMs:null,asOf:now});
    if(!Number.isFinite(start)||start>now)return unavailable('创建时间缺失、无效或在未来');
    if(parsed.errors.length)return unavailable('日志格式有误，无法可靠统计');
    if(parsed.mode!=='structured')return unavailable('日志未结构化，无法可靠统计');
    const replaced=new Set(parsed.events.map(e=>e.supersedes).filter(Boolean));
    const events=parsed.events.filter(e=>!replaced.has(e.id)).sort((a,b)=>instant(a.at)-instant(b.at)||a.order-b.order);
    let cursor=start,state='未知',lastState=null;
    const add=(end)=>{if(end>cursor)segments.push({start:cursor,end,state,ms:end-cursor});cursor=end;};
    let boundaries=0;
    for(const e of events){
      const to=e.type==='paused'?'暂停':e.state_to;
      if(!to)continue;
      const at=instant(e.at);
      if(!Number.isFinite(at))return unavailable('存在发生时间未知的状态变化，无法确定各区间边界');
      if(at<start||at>now){issues.push('存在超出统计范围的状态变化');continue;}
      if(![...taskStates,'暂停'].includes(to)){issues.push('存在无法识别的状态');continue;}
      // A conflicting state_from means this preceding interval has missing boundaries.
      if(e.state_from&&lastState&&e.state_from!==lastState&&state!=='暂停'){
        state='未知';issues.push('状态变化不连续，相关区间记为未知');
      }
      add(at);state=to;lastState=to==='暂停'?(e.state_from||lastState):to;boundaries++;
    }
    const terminal=['已完成','已取消'].includes(task.status);
    const agrees=lastState===task.status;
    if(!agrees){state='未知';issues.push('最新日志状态与当前任务状态不一致，尾段记为未知');}
    if(!terminal||!agrees)add(now);
    if(!boundaries)return unavailable('缺少带实际发生时间的 state_to 状态记录');
    const totals=Object.fromEntries([...taskStates,'暂停','未知'].map(s=>[s,0]));
    for(const segment of segments)totals[segment.state]+=segment.ms;
    if(parsed.legacy.trim())issues.push('包含未结构化历史日志');
    if(totals['未知'])issues.push('存在缺少状态记录的时间区间');
    return {available:true,issues:[...new Set(issues)],segments,totals,executionMs:totals['进行中'],asOf:now,complete:!issues.length,live:!terminal||!agrees};
  }
  function offsetTime(ms) {
    const seconds=Math.max(0,Math.floor(ms/1000));
    return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  }
  function activityTimeline(task,parsed,now=Date.now()) {
    if(parsed.errors.length)return {rows:[],points:[],issues:['日志格式有误，无法还原执行过程']};
    const replaced=new Set(parsed.events.map(e=>e.supersedes).filter(Boolean));
    const events=parsed.events.filter(e=>!replaced.has(e.id)),issues=[];
    const terminal=['已完成','已取消'].includes(task.status);
    const activities=[];
    for(const e of events){
      if(e.started_at===undefined)continue;
      const start=instant(e.started_at),end=e.ended_at===null?now:instant(e.ended_at);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now||start<instant(task.created_at)){
        issues.push('存在超出任务时间范围的活动记录');continue;
      }
      if(e.ended_at===null&&terminal){issues.push('任务已终结，但有活动未记录结束时间');continue;}
      activities.push({id:e.id,start,end,title:e.title,detail:e.detail,actor:e.actor,ongoing:e.ended_at===null,evidence:e.evidence});
    }
    activities.sort((a,b)=>a.start-b.start||a.end-b.end);
    const origin=activities[0]?.start;
    if(origin===undefined){
      const points=events.filter(e=>Number.isFinite(instant(e.at))&&instant(e.at)<=now).sort((a,b)=>instant(a.at)-instant(b.at)||a.order-b.order);
      const pointOrigin=points.length?instant(points[0].at):null;
      return {rows:[],points:points.map(e=>({...e,offset:instant(e.at)-pointOrigin})),origin:pointOrigin,issues:[...issues,'尚无活动起止记录；下方仅显示事件发生时点，不能推算每项工作持续时间']};
    }
    const rows=[];let cursor=origin;
    for(const activity of activities){
      if(activity.start>cursor)rows.push({id:'gap-'+cursor,start:cursor,end:activity.start,title:'这段时间未记录活动',unknown:true});
      const overlaps=activity.start<cursor;
      rows.push({...activity,overlaps});cursor=Math.max(cursor,activity.end);
    }
    if(!terminal&&cursor<now)rows.push({id:'gap-tail',start:cursor,end:now,title:'这段时间未记录活动',unknown:true});
    const points=events.filter(e=>e.started_at===undefined&&Number.isFinite(instant(e.at))&&instant(e.at)<=now);
    return {rows,points,origin,issues:[...new Set(issues)]};
  }
  function absoluteTime(ms) {
    return new Date(ms).toLocaleString('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  }
  function activityGraphModel(process,{width:canvasWidth=900,tickCount=5}={}) {
    const rows=[...process.rows,...process.points.map(e=>({...e,start:instant(e.at),end:instant(e.at),point:true}))].sort((a,b)=>a.start-b.start||a.end-b.end);
    if(!rows.length)return {rows:[],ticks:[]};
    const start=Math.min(...rows.map(r=>r.start)),end=Math.max(...rows.map(r=>r.end)),span=Math.max(1000,end-start);
    const left=canvasWidth<500?12:36,width=canvasWidth-left*2;
    return {start,end,width:canvasWidth,left,right:canvasWidth-left,height:66,
      ticks:Array.from({length:tickCount},(_,i)=>({at:start+span*i/(tickCount-1),x:left+width*i/(tickCount-1)})),
      rows:rows.map((r,i)=>({...r,x:left+(r.start-start)/span*width,barWidth:Math.max(3,(r.end-r.start)/span*width),y:34}))};
  }
  function renderTiming(container,task,parsed,now=Date.now(),{preview=false}={}) {
    const data=timing(task,parsed,now),process=activityTimeline(task,parsed,now),model=activityGraphModel(process,preview?{width:360,tickCount:3}:{});
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    const scroll=container.scrollTop,chartScroll=container.querySelector('.activity-chart-scroll')?.scrollLeft||0;
    const focusId=container.contains(document.activeElement)?document.activeElement?.closest('[data-activity-id]')?.dataset.activityId:null;
    container.replaceChildren();const header=el('div',undefined,'activity-header');if(!preview)header.append(el('h3','活动时间轴'));container.append(header);
    header.append(el('p',data.available?`总执行时间${data.complete?'':'（已记录）'}：${formatDuration(data.executionMs)} · 进行中累计`:'总执行时间：无法准确统计','task-time-total'));
    if(!model.rows.length){container.append(el('p',process.issues.join('；')||'尚无可核实的活动记录','timeline-note'));return;}
    container.append(el('p',`${absoluteTime(model.start)} — ${absoluteTime(model.end)} · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,'activity-date-range'));
    const wrapper=el('div',undefined,'activity-chart-scroll');wrapper.tabIndex=0;wrapper.setAttribute('aria-label','活动时间轴，可横向滚动查看完整时间刻度');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',`0 0 ${model.width} ${model.height}`);svg.setAttribute('class','activity-chart');svg.setAttribute('role','group');svg.setAttribute('aria-label','按绝对时间排列的活动时间轴');
    const shape=(tag,attrs={},text)=>{const n=document.createElementNS(svg.namespaceURI,tag);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,v);if(text!==undefined)n.textContent=text;return n;};
    svg.append(shape('line',{x1:model.left,x2:model.right,y1:44,y2:44,class:'activity-axis'}));
    for(const tick of model.ticks){
      svg.append(shape('line',{x1:tick.x,x2:tick.x,y1:25,y2:59,class:'activity-grid'}),shape('text',{x:tick.x,y:19,'text-anchor':tick.x===model.left?'start':tick.x===model.right?'end':'middle',class:'activity-tick'},absoluteTime(model.start).slice(0,10)===absoluteTime(model.end).slice(0,10)?absoluteTime(tick.at).slice(11):absoluteTime(tick.at).slice(5)));
    }
    const details=el('div',undefined,'activity-selection');details.setAttribute('role','tooltip');details.id=container.id+'-hover-tip';details.hidden=true;
    const show=(row,event)=>{
      details.hidden=false;
      const box=svg.querySelector(`[data-activity-id="${CSS.escape(row.id)}"]`)?.getBoundingClientRect();
      const px=event?.clientX??box?.left??20,py=event?.clientY??box?.bottom??20;
      details.style.left=Math.max(8,Math.min(px+12,innerWidth-330))+'px';
      details.style.top=Math.max(8,Math.min(py+16,innerHeight-190))+'px';
      container.dataset.selectedActivity=row.id;
      for(const item of svg.querySelectorAll('[data-activity-id]'))item.setAttribute('aria-pressed',String(item.dataset.activityId===row.id));
      details.replaceChildren(el('strong',row.title),el('p',row.point?absoluteTime(row.start):`${absoluteTime(row.start)} → ${absoluteTime(row.end)}`));
      details.append(el('p',row.point?'事件发生时点 · 未记录持续时间':`${formatDuration(row.end-row.start)}${row.ongoing?' · 进行中':''}${row.overlaps?' · 与其他活动并行':''}`,'timeline-note'));
      if(row.detail&&!row.unknown)details.append(el('p',row.detail));
      const concurrent=model.rows.filter(r=>r.id!==row.id&&!r.point&&!r.unknown&&(row.point?r.start<=row.start&&r.end>=row.start:r.start<row.end&&r.end>row.start));
      if(concurrent.length)details.append(el('p','同时间活动：'+concurrent.map(r=>r.title).join('、'),'timeline-note'));
    };
    const palette=['#67D8EF','#A99AF7','#79D6AA','#E8B871','#E898BC','#85ADF0','#C6CF78','#C799EF'];
    const colors=new Map(model.rows.filter(r=>!r.point&&!r.unknown).map((r,i)=>[r.id,palette[i%palette.length]]));
    for(const row of [...model.rows.filter(r=>!r.point),...model.rows.filter(r=>r.point)]){
      const group=shape('g',{class:`activity-mark${row.unknown?' activity-unknown':''}${row.point?' activity-point':''}`,'data-activity-id':row.id,tabindex:0,role:'button','aria-pressed':'false','aria-label':`${row.title}，${absoluteTime(row.start)}${row.point?'':' 至 '+absoluteTime(row.end)}`});
      group.append(shape('title',{},`${row.title}\n${absoluteTime(row.start)}${row.point?'':' → '+absoluteTime(row.end)}${row.detail?'\n'+row.detail:''}`));
      if(row.point)group.append(shape('path',{d:`M ${row.x} ${row.y+2} l 7 8 l -7 8 l -7 -8 Z`,class:'activity-bar'}));
      else group.append(shape('rect',{x:row.x,y:row.y+4,width:row.barWidth,height:18,rx:3,class:'activity-bar'}));
      const color=row.unknown?'#4e6076':colors.get(row.id)||'#d9e8f5';
      group.style.setProperty('--activity-color',color);group.setAttribute('aria-describedby',details.id);
      group.addEventListener('mouseenter',e=>show(row,e));group.addEventListener('mousemove',e=>show(row,e));
      group.addEventListener('mouseleave',()=>{details.hidden=true;});
      group.addEventListener('focus',()=>show(row));group.addEventListener('blur',()=>{details.hidden=true;});
      group.addEventListener('click',e=>show(row,e));group.addEventListener('keydown',e=>{if(e.key==='Escape'){details.hidden=true;group.blur();}else if(['Enter',' '].includes(e.key)){e.preventDefault();show(row);}});
      svg.append(group);
    }
    wrapper.append(svg);container.append(wrapper,details);
    if(!process.rows.length)container.append(el('p','仅有事件发生时点，尚未记录各项工作的持续时间。','timeline-note'));
    wrapper.scrollLeft=chartScroll;
    if(focusId)for(const item of svg.querySelectorAll('[data-activity-id]'))if(item.dataset.activityId===focusId)item.focus({preventScroll:true});
    container.scrollTop=scroll;
  }
  function summarize(detail,limit=120) {
    const text=String(detail||'').replace(/\s+/g,' ').trim();
    if(text.length<=limit)return {text,truncated:false};
    const sentence=text.match(/^.{1,120}?[。！？](?:\s|$)?/u)?.[0];
    return {text:sentence?.trim()||text.slice(0,limit)+'…',truncated:true};
  }
  function evidenceTarget(ref,base,root) {
    // A reference is a path/URL; legacy line annotations remain explanatory text.
    const match=ref.match(/^(.+?)\s+(补记前第\d+行[：:][\s\S]*)$/);
    const value=(match?match[1]:ref).trim(),note=match?.[2]||'';
    try {
      if(/^https?:\/\//i.test(value))return {url:new URL(value).href,note};
      if(/^\/(?:Users|Volumes|home|mnt|private|tmp)\//.test(value)){const url=new URL('task-log-file',root);url.searchParams.set('card',decodeURIComponent(new URL(base).pathname.slice(new URL(root).pathname.length)));url.searchParams.set('ref',ref);return {url:url.href,note};}
      if(value.startsWith('//')||/^[a-z][a-z\d+.-]*:/i.test(value)||/[\\\n\r]/.test(value))return {url:null,note};
      if(!/\.(?:md|csv|jsonl?|txt|log|html?|pdf|png|jpe?g|webp|svg|mp4|webm|glb|blend)(?:[?#][^\s]*)?$/i.test(value))return {url:null,note};
      const context=/^\.\.?\//.test(value)?base:root;
      const url=new URL(value,context);if(!['http:','https:'].includes(url.protocol))return {url:null,note};if(url.origin!==new URL(root).origin)return {url:null,note};
      return {url:url.href,note};
    }catch{return {url:null,note};}
  }
  function displayEntries(events) {
    const groups=new Map(),seen=new Set();
    for(const e of events)if(e.at===null){const key=instant(e.recorded_at);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
    const entries=[];
    for(const e of events){const key=instant(e.recorded_at),group=e.at===null?groups.get(key):null;
      if(group?.length>1){if(!seen.has(key)){entries.push({kind:'backfill',recordedAt:e.recorded_at,time:key,events:group});seen.add(key);}}
      else entries.push({kind:'event',event:e,time:e.time??instant(e.at??e.recorded_at)});
    }
    return entries;
  }
  function render(container,parsed,base=location.href,root=new URL('.',location.href).href) {
    const opened=new Set([...container.querySelectorAll('details[data-log-key][open]')].map(n=>n.dataset.logKey));
    const focused=document.activeElement?.closest('details[data-log-key]');
    const focusKey=container.contains(document.activeElement)?focused?.dataset.logKey:null,scroll=container.scrollTop;
    container.replaceChildren();
    const restore=(node,key)=>{node.dataset.logKey=key;node.open=opened.has(key);return node;};
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
    if(parsed.errors.length){const warning=el('div','日志格式有误，以下内容可能不完整：'+parsed.errors.join('；'),'timeline-warning');warning.setAttribute('role','alert');container.append(warning);}
    function renderEvent(e) {
      const item=el('li',undefined,'timeline-event');item.dataset.eventId=e.id;item.dataset.result=e.result||e.type;
      const date=new Date(e.time??instant(e.at??e.recorded_at)),time=el('time',date.toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}));time.dateTime=e.at??e.recorded_at;time.title=e.at??e.recorded_at;
      const summary=summarize(e.detail),showFull=summary.text!==e.detail;
      item.append(time,el('span',labels[e.type],'timeline-kind'),el('span',e.actor,'timeline-actor'),el('h3',e.title),el('p',summary.text,'timeline-summary'));
      if(e.at===null)item.append(el('p','发生时间未知 · 所示为补记时间','timeline-note'));else if(e.recorded_at)item.append(el('p','补记于 '+e.recorded_at,'timeline-note'));
      if(e.result)item.append(el('p','检查结果：'+({passed:'通过',failed:'失败',partial:'部分完成',not_run:'未运行'}[e.result]),'timeline-result'));
      if(e.state_from||e.state_to)item.append(el('p',`状态：${e.state_from||'未记录'} → ${e.state_to||'未记录'}`));
      const more=restore(el('details',undefined,'timeline-more'),'event:'+e.id);more.append(el('summary',showFull?'展开完整记录与依据':'查看依据与更多信息'));
      if(showFull)more.append(el('p',e.detail,'timeline-full-detail'));
      if(e.impact)more.append(el('p','影响：'+e.impact));
      if(e.route_from||e.route_to)more.append(el('p',`执行路由：${e.route_from||'未记录'} → ${e.route_to||'未记录'}`));
      if(e.supersedes)more.append(el('p','更正记录：'+e.supersedes,'timeline-note'));
      const refs=el('div',undefined,'timeline-evidence');for(const ref of e.evidence){const target=evidenceTarget(ref.ref,base,root),entry=el('div',undefined,'timeline-reference');
        if(target.url){const a=el('a',ref.label);a.href=target.url;a.target='_blank';a.rel='noopener noreferrer';entry.append(a);}
        else entry.append(el('span',ref.label+'：'+ref.ref));
        if(ref.note||target.note)entry.append(el('span',ref.note||target.note,'timeline-ref-note'));refs.append(entry);
      }more.append(refs);item.append(more);return item;
    }
    if(parsed.events.length){
      const entries=displayEntries(parsed.events),folded=entries.filter(x=>x.kind==='backfill').reduce((n,x)=>n+x.events.length,0);
      container.append(el('p',`${parsed.events.length} 条记录 · 按时间倒序 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}${folded?' · '+folded+'条补记已分组':''}`,'timeline-caption'));let list,day='';
      for(const entry of entries){const localDate=new Date(entry.time),nextDay=localDate.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'});
        if(nextDay!==day){day=nextDay;container.append(el('h3',day,'timeline-day'));list=el('ol',undefined,'task-timeline');container.append(list);}
        if(entry.kind==='event'){list.append(renderEvent(entry.event));continue;}
        const item=el('li',undefined,'timeline-backfill'),group=restore(el('details',undefined,'timeline-backfill-group'),'batch:'+entry.time);
        const failures=entry.events.filter(e=>e.result==='failed').length;if(failures)item.dataset.result='failed';
        group.append(el('summary',`历史补记 · ${entry.events.length}条记录（发生时间未知）${failures?' · 含'+failures+'条失败':''}`),el('p','发生时间未知；本组补记于 '+entry.recordedAt+'，不代表当天发生的进展。','timeline-note'));
        let rendered=false;const populate=()=>{if(group.open&&!rendered){rendered=true;const children=el('ol',undefined,'task-timeline timeline-backfill-events');for(const e of entry.events)children.append(renderEvent(e));group.append(children);}};group.addEventListener('toggle',populate);populate();
        item.append(group);list.append(item);
      }
    }else if(!parsed.errors.length&&!parsed.legacy.trim())container.append(el('p','尚无任务日志','timeline-caption'));
    if(parsed.legacy.trim()){const legacy=restore(el('details',undefined,'timeline-legacy-group'),'legacy');legacy.append(el('summary','历史日志原文（未结构化，不推测时间）'),el('pre',parsed.legacy,'timeline-legacy'));container.append(legacy);}
    if(focusKey)for(const node of container.querySelectorAll('details[data-log-key]'))if(node.dataset.logKey===focusKey){node.querySelector('summary')?.focus({preventScroll:true});break;}
    container.scrollTop=scroll;
  }
  globalThis.TaskLog={parse,section,instant,labels,summarize,evidenceTarget,displayEntries,render,timing,formatDuration,renderTiming,activityTimeline,offsetTime,activityGraphModel,absoluteTime};
})();
