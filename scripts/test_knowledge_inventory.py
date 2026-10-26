"""Synthetic first-knowledge initialization and interrupted bootstrap recovery."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import knowledge as k
import knowledge_inventory as inv
from test_knowledge import entry, block

class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name).resolve()
        for name in ['private','docs']:(self.base/name).mkdir()
        (self.base/'docs/README.md').write_text('示例客户端只在离线模式保留草稿。\n')
        (self.base/'docs/rules.md').write_text('示例决定：发布必须经过明确确认。\n')
        self.cfg=self.base/'config.json'
        self.p={'root':'private','files':['initial.md'],'writable':True,
                'authorization':{'reference':'fictional-initialization','scope':'private knowledge'},
                'inventory':{'root':'docs','files':['README.md','rules.md'],'output':'initial.md',
                             'authorization':{'reference':'fictional-project-read','scope':'two selected documents'}}}
        self.c={'version':1,'index_root':'index','projects':{'demo':self.p}};self.save()
    def save(self):self.cfg.write_text(json.dumps(self.c))
    def cli(self,*args,private=False,ok=True,config=True):
        out=io.StringIO()
        with contextlib.redirect_stdout(out):
            code=k.main((['--config',str(self.cfg)] if config else [])+(['--private-output'] if private else [])+list(args))
        value=json.loads(out.getvalue());self.assertEqual(code,0 if ok else 1,value);return value
    def state(self,**kw):return self.cli('inventory-state','--project','demo',**kw)
    def plan(self,**kw):return self.cli('inventory-plan','--project','demo',private=True,**kw)
    def bundle(self,plan):
        value=[entry('DEMO-FIRST',title='离线草稿条件',sources=[plan['documents'][0]['reference']])]
        path=self.base/'entries.json';path.write_text(json.dumps(value));return path
    def commit(self,plan,**kw):return self.cli('inventory-commit','--project','demo','--plan-id',plan['plan_id'],'--entries',str(self.bundle(plan)),**kw)
    def test_end_to_end_repeated_initialization_is_idempotent(self):
        self.assertEqual(self.state()['state'],'empty')
        plan=self.plan();self.assertEqual(plan['read_bytes'],sum(x['bytes'] for x in plan['documents']))
        again=self.plan();self.assertEqual(plan['plan_id'],again['plan_id'])
        self.assertEqual(self.commit(plan)['state'],'ready')
        raw=(self.base/'private/initial.md').read_bytes();self.assertEqual(self.state()['state'],'ready')
        self.assertFalse(self.plan()['inventory_started']);self.commit(plan)
        self.assertEqual(raw,(self.base/'private/initial.md').read_bytes())
        self.assertTrue(self.cli('search','认证失败',private=True)['results'])
    def test_existing_body_without_index_rebuild_not_inventory(self):
        (self.base/'private/initial.md').write_text(block(entry()))
        self.assertEqual(self.state()['state'],'rebuild-needed')
        self.assertFalse(self.plan()['inventory_started'])
        self.cli('build');self.assertEqual(self.state()['state'],'ready')
    def test_no_config_and_unauthorized_never_empty(self):
        self.assertEqual(self.state(config=False)['state'],'unconfigured')
        self.cfg.unlink();self.assertEqual(self.state()['state'],'unconfigured');self.save()
        self.p['writable']=False;self.save();self.assertEqual(self.state(ok=False)['state'],'unauthorized')
        self.p['writable']=True;self.p['inventory']['authorization']={};self.save()
        self.assertEqual(self.state(ok=False)['state'],'unauthorized')
    def test_plain_legacy_corruption_missing_read_failure_not_empty(self):
        target=self.base/'private/initial.md'
        target.write_text('已有未结构化的用户决定，不能覆盖')
        self.assertEqual(self.state()['state'],'unstructured');self.assertFalse(self.plan()['inventory_started'])
        target.write_text(k.START);self.assertEqual(self.state(ok=False)['state'],'invalid-or-unavailable')
        target.unlink();self.p['files'].append('lost.md');self.save()
        self.assertEqual(self.state(ok=False)['state'],'invalid-or-unavailable')
        self.p['files'].pop();self.save()
        with patch.object(k.os,'open',side_effect=PermissionError('private-path-canary')):
            r=self.state(ok=False);self.assertNotIn('private-path-canary',str(r))
    def test_budget_literal_sources_private_output_and_boundaries(self):
        (self.base/'docs/README.md').write_text('长'*1000)
        p=self.cli('inventory-plan','--project','demo','--bytes','30','--max-files','1',private=True)
        self.assertEqual(p['read_bytes'],30);self.assertFalse(p['complete']);self.assertTrue(p['documents'][0]['truncated'])
        self.assertFalse(self.commit(p)['inventory_coverage_complete'])
        self.cli('inventory-plan','--project','demo',ok=False)
        self.cli('inventory-plan','--project','demo','--max-files','6',private=True,ok=False)
    def test_symlink_fifo_and_scope_denied(self):
        path=self.base/'docs/README.md';path.unlink();path.symlink_to(self.base/'docs/rules.md')
        self.assertEqual(self.state(ok=False)['error'],'symlink-denied')
        path.unlink();os.mkfifo(path);self.assertEqual(self.state(ok=False)['error'],'regular-file-required')
        path.unlink();path.write_text('demo')
        self.p['inventory']['files']=['../outside.md'];self.save();self.state(ok=False)
    def test_partial_failure_preserves_source_and_retry(self):
        p=self.plan();real=k.atomic
        def fail_index(path,data):
            if path.name=='demo.json':raise OSError('fictional-index-error')
            return real(path,data)
        with patch.object(k,'atomic',side_effect=fail_index):
            r=self.commit(p,ok=False);self.assertTrue(r['source_written']);self.assertFalse(r['indexed'])
        self.assertEqual(self.state()['state'],'partial')
        raw=(self.base/'private/initial.md').read_bytes();self.commit(p)
        self.assertEqual(raw,(self.base/'private/initial.md').read_bytes());self.assertEqual(self.state()['state'],'ready')
    def test_source_changes_receipt_forgery_and_lost_output(self):
        p=self.plan();(self.base/'docs/README.md').write_text('changed')
        self.assertEqual(self.commit(p,ok=False)['error'],'inventory-source-changed')
        (self.base/'index/demo.inventory.json').write_text('{')
        self.assertNotEqual(self.state(ok=False)['state'],'empty')
    def test_knowledge_appearing_after_plan_never_overwritten(self):
        p=self.plan();target=self.base/'private/initial.md';target.write_text(block(entry('OTHER')))
        before=target.read_bytes();self.commit(p,ok=False);self.assertEqual(before,target.read_bytes())
    def test_receipt_does_not_prove_completion_and_missing_body_is_fault(self):
        p=self.plan();self.commit(p)
        (self.base/'private/initial.md').unlink()
        self.assertEqual(self.state(ok=False)['error'],'inventory-output-lost')
    def test_blank_prefix_is_preserved_and_retry_idempotent(self):
        target=self.base/'private/initial.md';target.write_bytes(b'  \n\t\n')
        self.assertEqual(self.state()['state'],'empty');p=self.plan();self.commit(p)
        raw=target.read_bytes();self.assertTrue(raw.startswith(b'  \n\t\n'))
        self.commit(p);self.assertEqual(raw,target.read_bytes());self.assertEqual(self.state()['state'],'ready')
    def test_actual_output_permission_blocks_plan_before_reading_documents(self):
        with patch.object(inv.os,'access',return_value=False), patch.object(inv,'bounded_document',side_effect=AssertionError('must not read')):
            r=self.state(ok=False);self.assertEqual(r['state'],'unauthorized')
            r=self.plan(ok=False);self.assertEqual(r['error'],'inventory-output-not-writable')
        self.assertFalse((self.base/'index/demo.inventory.json').exists())
    def test_forged_coverage_true_and_linked_config_rejected(self):
        (self.base/'docs/README.md').write_text('long content'*100)
        p=self.cli('inventory-plan','--project','demo','--bytes','10',private=True)
        path=self.base/'index/demo.inventory.json';r=json.loads(path.read_text());r['plan']['coverage_complete']=True
        r['plan_id']=k.digest(k.canonical(r['plan']).encode());path.write_text(json.dumps(r))
        result=self.cli('inventory-commit','--project','demo','--plan-id',r['plan_id'],
                        '--entries',str(self.bundle(p)),ok=False)
        self.assertEqual(result['error'],'inventory-receipt-invalid')
        self.cfg.unlink();self.cfg.symlink_to(self.base/'absent-config.json')
        self.assertEqual(self.state(ok=False)['error'],'symlink-denied')

    def test_forged_receipt_completion_cannot_echo_private_value(self):
        p=self.plan();path=self.base/'index/demo.inventory.json';r=json.loads(path.read_text())
        r['plan']['coverage_complete']='FICTIONAL_PRIVATE_CANARY'
        r['plan_id']=k.digest(k.canonical(r['plan']).encode());path.write_text(json.dumps(r))
        result=self.cli('inventory-commit','--project','demo','--plan-id',r['plan_id'],
                        '--entries',str(self.bundle(p)),ok=False)
        self.assertNotIn('FICTIONAL_PRIVATE_CANARY',str(result))
        self.assertEqual(result['error'],'inventory-receipt-invalid')

    def test_inventory_source_not_automatically_discovered_and_grant_rechecked(self):
        (self.base/'docs/unmapped.md').write_text('PRIVATE-UNMAPPED-CANARY')
        p=self.plan();self.assertNotIn('PRIVATE-UNMAPPED-CANARY',str(p))
        e=json.loads(self.bundle(p).read_text());e[0]['sources']=['unmapped-source'];bundle=self.base/'bad.json';bundle.write_text(json.dumps(e))
        self.cli('inventory-commit','--project','demo','--plan-id',p['plan_id'],'--entries',str(bundle),ok=False)
        self.p['inventory']['authorization']['reference']='changed-grant';self.save()
        self.assertEqual(self.state(ok=False)['error'],'inventory-plan-stale')

if __name__=='__main__':unittest.main()
