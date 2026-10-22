#!/usr/bin/env python3
"""Independent test suite scaffold, structural validation and public-only brief."""
import argparse
import csv
import json
import re
from datetime import datetime
from pathlib import Path

SCENARIOS = ('scenario_id','goal','steps','expected')
ISSUES = ('issue_id','scenario_id','kind','severity','summary','steps','expected','actual','frequency','evidence','found_run','status','decision','repair_tasks','duplicate_of','verified_run')
METHODS = {'黑盒体验','接口','代码','性能'}
STATES = {'待分诊','待修复','待复验','已关闭','暂不处理'}
RESULTS = {'通过','发现问题','受阻','未测'}

def safe(root, value):
    if not isinstance(value,str) or not value or '\\' in value or Path(value).is_absolute() or any(x in ('','..','.') for x in value.split('/')):
        raise ValueError('unsafe repository-relative path: '+str(value))
    result=(root/value).resolve()
    result.relative_to(root.resolve())
    return result

def evidence_path(root, value):
    if not isinstance(value, str) or not value.startswith('evidence/'):
        raise ValueError('test artifact must be under evidence/: '+str(value))
    result = safe(root, value)
    result.relative_to(root.resolve() / 'evidence')
    return result

def canonical_issue(root, reference, current_issues, label):
    if '#' in reference:
        file, issue_id = reference.rsplit('#', 1)
        targets = rows(evidence_path(root, file), ISSUES)
    else:
        issue_id = reference
        targets = current_issues
    matches = [item for item in targets if item['issue_id'] == issue_id]
    if issue_id == label or len(matches) != 1 or matches[0]['duplicate_of']:
        raise ValueError('unknown/noncanonical duplicate target: '+reference)
    return matches[0]

def rows(path, headers):
    with path.open(encoding='utf-8',newline='') as f:
        reader=csv.DictReader(f)
        if tuple(reader.fieldnames or ())!=headers: raise ValueError('invalid CSV header: '+str(path))
        out=list(reader)
        if any(None in x or any(v is None for v in x.values()) for x in out): raise ValueError('malformed CSV row: '+str(path))
        return out

def suite(root, spec_path, completed=False, known_tasks=None):
    errors=[]
    try:
        spec=json.loads(evidence_path(root,spec_path).read_text())
        for key in ('task_id','method','target','version','environment','owner','access','report','scenarios','issues','runs'):
            if not spec.get(key): errors.append('missing suite '+key)
        if not re.fullmatch(r'[A-Z][A-Z0-9]*-\d+',str(spec.get('task_id',''))): errors.append('invalid suite task id')
        if completed and any('待' in str(spec.get(k,'')) for k in ('target','version','environment','owner')): errors.append('completed suite has placeholder inputs')
        if spec.get('method') not in METHODS: errors.append('invalid test method')
        if spec.get('method')=='黑盒体验' and spec.get('access')!='public-only': errors.append('blackbox requires public-only access')
        for key in ('report','scenarios','issues','runs'):
            if not str(spec.get(key,'')).startswith('evidence/'): errors.append('artifact must be in evidence: '+key)
        scenarios=rows(evidence_path(root,spec['scenarios']),SCENARIOS)
        issues=rows(evidence_path(root,spec['issues']),ISSUES)
        runs=[json.loads(x) for x in evidence_path(root,spec['runs']).read_text().splitlines() if x.strip()]
        sids=[x['scenario_id'] for x in scenarios]; iids=[x['issue_id'] for x in issues]; rids=[x.get('run_id') for x in runs]
        for name, ids in [('scenario',sids),('issue',iids),('run',rids)]:
            if len(ids)!=len(set(ids)) or any(not x for x in ids): errors.append('duplicate/empty '+name+' id')
        for s in scenarios:
            if any(not s[k].strip() for k in SCENARIOS): errors.append('incomplete scenario '+s['scenario_id'])
        run_index={x.get('run_id'):x for x in runs}
        for run in runs:
            for k in ('run_id','version','environment','at','scenario_results','issue_results'):
                if k not in run or not run[k] and k not in ('issue_results',): errors.append('missing run '+k)
            if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)',run.get('at','')): errors.append('invalid run timestamp')
            if not set(run.get('scenario_results',{})).issubset(set(sids)): errors.append('unknown scenario in run')
            for result in run.get('scenario_results',{}).values():
                if result not in RESULTS: errors.append('invalid scenario result')
            for iid,result in run.get('issue_results',{}).items():
                if iid not in iids or result.get('result') not in {'通过','仍存在','受阻','未测'}: errors.append('invalid issue result')
                for e in result.get('evidence',[]):
                    if not evidence_path(root,e).is_file(): errors.append('missing retest evidence '+e)
        if known_tasks is None and any(issue['repair_tasks'].strip() for issue in issues):
            try:
                from generate_tasks import load_tasks
                known_tasks = {task.task_id for task in load_tasks(root/'TASKS.csv')}
            except (ValueError, OSError) as error:
                errors.append('cannot verify repair tasks against TASKS.csv: '+str(error))
                known_tasks = set()
        for issue in issues:
            label=issue['issue_id']
            if not label.startswith(spec['task_id']+'-P'): errors.append('issue ID must be task-scoped: '+label)
            if issue['scenario_id'] not in sids: errors.append('unknown scenario '+label)
            if issue['kind'] not in {'缺陷','体验建议','待确认'} or issue['severity'] not in {'阻断','重大','一般','轻微'}: errors.append('invalid classification '+label)
            if issue['status'] not in STATES: errors.append('invalid issue status '+label)
            for key in ('summary','steps','expected','actual','frequency','evidence','found_run'):
                if not issue[key].strip(): errors.append('missing '+key+' '+label)
            if issue['found_run'] not in run_index: errors.append('unknown discovery run '+label)
            elif label not in run_index[issue['found_run']].get('issue_results',{}): errors.append('missing discovery observation '+label)
            for e in issue['evidence'].split(';'):
                if e and not evidence_path(root,e).is_file(): errors.append('missing evidence '+e)
            repairs=[x.strip() for x in issue['repair_tasks'].split(';') if x.strip()]
            if known_tasks is not None and any(x not in known_tasks for x in repairs): errors.append('unknown repair task '+label)
            if issue['status'] in {'待修复','待复验'} and not repairs: errors.append('repair task required '+label)
            if issue['status']=='暂不处理' and not issue['decision']: errors.append('decision required '+label)
            if issue['duplicate_of'] and (issue['duplicate_of']==label or not issue['decision']): errors.append('invalid duplicate reference '+label)
            if issue['duplicate_of']:
                try: canonical_issue(root, issue['duplicate_of'], issues, label)
                except (ValueError, OSError) as error: errors.append(str(error)+' '+label)
            if issue['status']=='已关闭':
                result=run_index.get(issue['verified_run'],{}).get('issue_results',{}).get(label,{})
                discovery=run_index.get(issue['found_run'],{})
                verification=run_index.get(issue['verified_run'],{})
                if issue['found_run']==issue['verified_run'] or datetime.fromisoformat(verification.get('at','').replace('Z','+00:00'))<=datetime.fromisoformat(discovery.get('at','').replace('Z','+00:00')): errors.append('retest must follow discovery '+label)
                if result.get('result')!='通过' or not result.get('evidence'): errors.append('closure requires successful evidenced retest '+label)
            if completed and (issue['status']=='待分诊' or not issue['decision']): errors.append('completed delivery has untriaged issue '+label)
        if completed:
            if runs and set(runs[-1].get('scenario_results',{}))!=set(sids): errors.append('latest run must include all current scenarios, including untested')
            if runs and not any(v in {"通过","发现问题"} for run in runs for v in run.get("scenario_results",{}).values()): errors.append("completed test has no actually executed scenario")
            if not scenarios or not runs: errors.append('completed test requires scenarios and actual run records')
            if not evidence_path(root,spec['report']).is_file() or not evidence_path(root,spec['report']).read_text().strip(): errors.append('completed test requires report')
        return errors,spec,{'scenarios':len(scenarios),'issues':len(issues),'open':sum(x['status'] not in {'已关闭','暂不处理'} for x in issues),'blocking':sum(x['severity']=='阻断' and x['status'] not in {'已关闭','暂不处理'} for x in issues)}
    except (ValueError,KeyError,TypeError,OSError,AttributeError,IndexError) as e:
        return errors+[str(e)],{},{}

def validate_task_suite(root,task,fields):
    link=fields.get('测试清单','')
    if not link: return ['missing 测试清单: '+task.task_id]
    from generate_tasks import load_tasks
    known={x.task_id for x in load_tasks(root/'TASKS.csv')}
    errors,spec,_=suite(root,link,task.status=='已完成',known)
    if spec.get('task_id')!=task.task_id: errors.append('suite task identity mismatch')
    if spec.get('method')!=fields.get('测试方式'): errors.append('test method mismatch')
    text=(root/task.detail_path).read_text()
    for key in ('report','scenarios','issues','runs'):
        if spec.get(key) and spec[key] not in text: errors.append('task missing artifact link: '+key)
    return [task.task_id+': '+x for x in errors]

def init(root,task_id,directory,method):
    if not re.fullmatch(r'[A-Z][A-Z0-9]*-\d+',task_id): raise ValueError('invalid task ID')
    if not directory.startswith('evidence/'): raise ValueError('suite output must be under evidence/')
    folder=evidence_path(root,directory)
    if folder.exists(): raise ValueError('refuse to overwrite existing suite')
    folder.mkdir(parents=True)
    spec=dict(task_id=task_id,method=method,target='待经理填写用户入口',version='待固定',environment='待填写',owner='待登记单一写入者',access='public-only' if method=='黑盒体验' else 'task-scoped')
    for key,name in [('report','report.md'),('scenarios','scenarios.csv'),('issues','issues.csv'),('runs','runs.jsonl')]: spec[key]=directory+'/'+name
    (folder/'suite.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n')
    for name,headers in [('scenarios.csv',SCENARIOS),('issues.csv',ISSUES)]:
        with (folder/name).open('w',newline='') as f: csv.writer(f).writerow(headers)
    (folder/'runs.jsonl').write_text('')
    (folder/'report.md').write_text('# 测试报告\n\n准备阶段，尚未执行。\n')
    return directory+'/suite.json'

def main():
    p=argparse.ArgumentParser();p.add_argument('--repo',required=True); sub=p.add_subparsers(dest='action',required=True)
    a=sub.add_parser('init');a.add_argument('--task',required=True);a.add_argument('--directory',required=True);a.add_argument('--method',default='黑盒体验',choices=sorted(METHODS))
    for name in ('validate','brief'):
        a=sub.add_parser(name);a.add_argument('--suite',required=True);a.add_argument('--completed',action='store_true')
    args=p.parse_args();root=Path(args.repo).resolve()
    if args.action=='init': print(init(root,args.task,args.directory,args.method));return 0
    errors,spec,summary=suite(root,args.suite,args.completed)
    if args.action=='brief':
        if errors: print(json.dumps({'errors':errors},ensure_ascii=False));return 1
        if any('待' in str(spec.get(k,'')) for k in ('target','version','environment','owner')): print('Incomplete dispatch brief');return 1
        public={k:spec[k] for k in ('task_id','method','target','version','environment','access')}
        public['scenarios']=rows(evidence_path(root,spec['scenarios']),SCENARIOS)
        public['constraints']='只观察用户可见表现；禁止读取源码、实现说明、自测结论、DevTools内部状态或网络实现。只用授权浏览器界面与证据输出工具；受阻如实记录；报告现象，不猜根因。'
        print(json.dumps(public,ensure_ascii=False,indent=2));return 0
    print(json.dumps({'errors':errors,'summary':summary},ensure_ascii=False));return bool(errors)
if __name__=='__main__': raise SystemExit(main())
