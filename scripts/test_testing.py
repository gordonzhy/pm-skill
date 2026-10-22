import csv,json,tempfile,unittest
from pathlib import Path
import testing
from generate_tasks import CSV_HEADERS
class TestingContract(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  self.specpath=testing.init(self.root,'QA-001','evidence/qa-001/run','黑盒体验')
  self.spec=json.loads((self.root/self.specpath).read_text());self.spec.update(target='http://localhost:5184',version='candidate-A',environment='PC Chrome',owner='tester')
  (self.root/self.specpath).write_text(json.dumps(self.spec))
  self.write('scenarios',testing.SCENARIOS,[dict(zip(testing.SCENARIOS,['S-01','阅读内容','进入、打开','可读可返回']))])
  self.evidence='evidence/qa-001/run/observation.txt';(self.root/self.evidence).write_text('observed interaction')
  self.runs=[dict(run_id='R1',version='candidate-A',environment='PC Chrome',at='2026-10-09T10:00:00Z',scenario_results={'S-01':'发现问题'},issue_results={'QA-001-P001':dict(result='仍存在',evidence=[self.evidence])})]
  self.issue={k:'' for k in testing.ISSUES};self.issue.update(issue_id='QA-001-P001',scenario_id='S-01',kind='缺陷',severity='阻断',summary='无法返回',steps='进入、打开、点击返回',expected='返回大厅',actual='无响应',frequency='3/3',evidence=self.evidence,found_run='R1',status='待修复',decision='经理:本阶段修复',repair_tasks='DEV-001')
  with (self.root/'TASKS.csv').open('w',newline='') as f:
   w=csv.writer(f);w.writerow(CSV_HEADERS);w.writerow(['DEV-001','待办','P1','QA','Fix','[]','dev','2026-10-09T00:00:00Z','2026-10-09T00:00:00Z','tasks/DEV-001.md']+['']*8)
  self.save()
 def tearDown(self): self.tmp.cleanup()
 def write(self,key,headers,values):
  with (self.root/self.spec[key]).open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=headers);w.writeheader();w.writerows(values)
 def save(self):
  self.write('issues',testing.ISSUES,[self.issue]);(self.root/self.spec['runs']).write_text(''.join(json.dumps(r)+'\n' for r in self.runs))
 def check(self,**kw): return testing.suite(self.root,self.specpath,**kw)[0]
 def test_complete_with_open_defect_is_valid(self): self.assertEqual([],self.check(completed=True,known_tasks={'DEV-001'}))
 def test_unknown_repair_is_rejected(self): self.assertTrue(self.check(known_tasks=set()))
 def test_close_requires_separate_evidenced_retest(self):
  self.issue.update(status='已关闭',verified_run='R1');self.save();self.assertTrue(self.check())
  self.runs.append(dict(run_id='R2',version='candidate-B',environment='PC Chrome',at='2026-10-09T11:00:00Z',scenario_results={'S-01':'通过'},issue_results={'QA-001-P001':dict(result='通过',evidence=[self.evidence])}));self.issue['verified_run']='R2';self.save();self.assertEqual([],self.check(completed=True))
 def test_missing_evidence_is_not_zero_problems(self): (self.root/self.evidence).unlink();self.assertTrue(self.check())
 def test_traversal_and_symlink_rejected(self):
  self.spec['issues']='../issues.csv';(self.root/self.specpath).write_text(json.dumps(self.spec));self.assertTrue(self.check())
  with tempfile.TemporaryDirectory() as other:
   link=self.root/'evidence/link.csv';link.symlink_to(Path(other)/'issue.csv');self.spec['issues']='evidence/link.csv';(self.root/self.specpath).write_text(json.dumps(self.spec));self.assertTrue(self.check())
 def test_duplicate_ids_and_untriaged_completion(self):
  self.write('issues',testing.ISSUES,[self.issue,self.issue]);self.assertTrue(self.check())
  self.issue.update(status='待分诊',decision='');self.save();self.assertTrue(self.check(completed=True))
 def test_previous_round_survives_new_scenario(self):
  rows=[dict(zip(testing.SCENARIOS,['S-01','阅读','打开','可读'])),dict(zip(testing.SCENARIOS,['S-02','返回','返回','大厅']))];self.write('scenarios',testing.SCENARIOS,rows)
  self.assertEqual([],self.check());self.assertTrue(self.check(completed=True))
 def test_init_refuses_overwrite(self):
  with self.assertRaises(ValueError): testing.init(self.root,'QA-001','evidence/qa-001/run','黑盒体验')
 def test_invalid_json_shape_fails_cleanly(self):
  (self.root/self.specpath).write_text('[]');self.assertTrue(self.check())
 def test_standalone_unknown_repair_fails(self):
  self.issue['repair_tasks']='DEV-999';self.save();self.assertTrue(any('unknown repair' in e for e in self.check()))
 def test_missing_task_source_fails_only_with_repair_reference(self):
  (self.root/'TASKS.csv').unlink();self.assertTrue(any('cannot verify' in e for e in self.check()))
  self.write('issues',testing.ISSUES,[]);self.runs[0]['issue_results']={};self.runs[0]['scenario_results']={'S-01':'通过'};(self.root/self.spec['runs']).write_text(json.dumps(self.runs[0])+'\n');self.assertEqual([],self.check(completed=True))
 def test_suite_outside_evidence_is_rejected(self):
  (self.root/'app').mkdir();(self.root/'app/suite.json').write_text(json.dumps(self.spec));self.assertTrue(testing.suite(self.root,'app/suite.json')[0])
 def test_suite_symlink_to_source_is_rejected(self):
  (self.root/'app').mkdir();(self.root/'app/suite.json').write_text(json.dumps(self.spec));(self.root/'evidence/link.json').symlink_to(self.root/'app/suite.json');self.assertTrue(testing.suite(self.root,'evidence/link.json')[0])
 def test_duplicate_unknown_target_rejected(self):
  self.issue['duplicate_of']='QA-001-P999';self.save();self.assertTrue(any('unknown/noncanonical' in e for e in self.check()))
 def test_duplicate_canonical_cross_suite_exists_and_is_unique(self):
  canonical=dict(self.issue,issue_id='QA-002-P001',duplicate_of='');dest=self.root/'evidence/other.csv'
  with dest.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=testing.ISSUES);w.writeheader();w.writerow(canonical)
  self.issue['duplicate_of']='evidence/other.csv#QA-002-P001';self.save();self.assertEqual([],self.check())
  canonical['duplicate_of']='QA-999-P001'
  with dest.open('w',newline='') as f:w=csv.DictWriter(f,fieldnames=testing.ISSUES);w.writeheader();w.writerow(canonical)
  self.assertTrue(any('noncanonical' in e for e in self.check()))
if __name__=='__main__':unittest.main()
