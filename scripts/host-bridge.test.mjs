import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectHostBridge, consumeHostIdentity } from './core/host-bridge.mjs';
import { result } from './core/engine.mjs';
import { EMPTY_PROJECT_REVISION, VERSION, fail } from './core/contracts.mjs';

// This is a synthetic protocol peer. It provides no real host-authentication evidence.
async function fixture({ authenticated = true, mode = 'valid' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-fixture-')));
  await fs.chmod(root, 0o700);
  const profile = path.join(root, 'profile'); await fs.mkdir(profile, { mode: 0o700 });
  const executable = path.join(root, 'protocol-peer');
  const request = { protocol: VERSION.protocol, command: 'work create', repo: root,
    project_id: 'ATLAS', idempotency_key: 'create-a', expected_revision: EMPTY_PROJECT_REVISION,
    input: { work: 'ATLAS-01', scope: { goal: 'Example', allowed_writes: ['out'], exclusions: [], criteria: ['c1'] }, label: 'Example', deps: [], impact: [] } };
  const source = `#!${process.execPath}
const fs=require('node:fs');const response=${JSON.stringify(path.join(root,'response.json'))};
const authenticated=${JSON.stringify(authenticated)},mode=${JSON.stringify(mode)},request=${JSON.stringify(request)};
let buf='';const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
process.stdin.on('data',chunk=>{buf+=chunk;for(;;){const n=buf.indexOf('\\n');if(n<0)break;const q=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);
if(q.id===100&&q.result)fs.writeFileSync(response,JSON.stringify(q.result));
if(q.method==='initialize')send({id:q.id,result:{userAgent:'synthetic'}});
else if(q.method==='account/read')send({id:q.id,result:{account:authenticated?{type:'synthetic'}:null,requiresOpenaiAuth:true}});
else if(q.method==='thread/read'){send({id:q.id,result:{thread:{id:mode==='wrong-route'?'OTHER':q.params.threadId}}});
if(mode!=='wrong-route')setTimeout(()=>{const args=structuredClone(request);if(mode==='self-proof')args.actor_proof='local-owner';if(mode==='wrong-project')args.project_id='ORBIT';
if(mode==='utf8')args.input.scope.goal='中文🙂';
const p={threadId:mode==='unbound'?'OTHER':'THREAD-A',turnId:'TURN-A',callId:'CALL-A',tool:'pm_command',arguments:args};
if(mode==='utf8'){const b=Buffer.from(JSON.stringify({id:100,method:'item/tool/call',params:p})+'\\n');const at=b.indexOf('中')+1;process.stdout.write(b.subarray(0,at));setTimeout(()=>process.stdout.write(b.subarray(at)),35);}else send({id:100,method:'item/tool/call',params:p});if(mode==='duplicate')setTimeout(()=>send({id:101,method:'item/tool/call',params:p}),20);
},10);}
}});
`;
  await fs.writeFile(executable, source, { mode: 0o700 });
  return { root, profile, executable, request, async cleanup() { await fs.rm(root, { recursive: true, force: true }); } };
}
const binding = root => ({ thread_id: 'THREAD-A', actor: 'manager-a', manager_epoch: 'epoch-a',
  project_id: 'ATLAS', role: 'manager', repo: root });
const expected = root => ({ actor: 'manager-a', manager_epoch: 'epoch-a', project_id: 'ATLAS', role: 'manager', repo: root });
const delay = ms => new Promise(r => setTimeout(r, ms));

test('plain strings, objects and self-signed JSON cannot mint a host identity', () => {
  for (const token of ['local-owner', 'host:example', {}, { actor: 'manager-a', role: 'manager' }])
    assert.throws(() => consumeHostIdentity(token, {}, {}), { code: 'AUTH_REQUIRED' });
});

test('synthetic host envelope authenticates exact command once and keeps arguments separate', async () => {
  const f = await fixture(); let called = 0; let done;
  const received = new Promise(r => done = r);
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async (request, token) => {
      called++;
      const identity = consumeHostIdentity(token, request, expected(f.root));
      assert.equal(identity.thread_id, 'THREAD-A'); assert.equal(identity.turn_id, 'TURN-A');
      assert.equal(identity.call_id, 'CALL-A'); assert.equal(identity.assurance, 'host-transport');
      assert.throws(() => consumeHostIdentity(token, request, expected(f.root)), { code: 'AUTH_REQUIRED' });
      done(); return result('NO_CHANGE');
    } });
  try {
    assert.equal(bridge.capability.host_effects, false);
    await bridge.bindOwnerEstablishedRoute(binding(f.root));
    await Promise.race([received, delay(2000).then(() => assert.fail('missing synthetic call'))]);
    assert.equal(called, 1);
  } finally { bridge.close(); await f.cleanup(); }
});

for (const [name, mode] of [['self-reported proof', 'self-proof'], ['unbound host thread', 'unbound'], ['cross-project request', 'wrong-project']]) {
  test(`rejects ${name} before invoking command handler`, async () => {
    const f = await fixture({ mode }); let called = 0;
    const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
      onCommand: async () => { called++; } });
    try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); await delay(150); assert.equal(called, 0); }
    finally { bridge.close(); await f.cleanup(); }
  });
}

test('unauthenticated profile cannot bind or execute; no general RPC escape', async () => {
  const f = await fixture({ authenticated: false });
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async () => assert.fail('must not call') });
  try {
    assert.equal(bridge.capability.authenticated, false);
    await assert.rejects(bridge.bindOwnerEstablishedRoute(binding(f.root)), { code: 'AUTH_REQUIRED' });
    await assert.rejects(bridge.inspect('turn/start', {}), { code: 'CAPABILITY_UNAVAILABLE' });
    await assert.rejects(bridge.inspect('thread/read', { threadId: 'OTHER' }), { code: 'AUTH_DENIED' });
    await assert.rejects(bridge.inspect('thread/list', {}), { code: 'CAPABILITY_UNAVAILABLE' });
  } finally { bridge.close(); await f.cleanup(); }
});

test('route lookup mismatch does not establish a binding', async () => {
  const f = await fixture({ mode: 'wrong-route' });
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async () => assert.fail('must not call') });
  try { await assert.rejects(bridge.bindOwnerEstablishedRoute(binding(f.root)), { code: 'AUTH_DENIED' }); }
  finally { bridge.close(); await f.cleanup(); }
});

test('binding role and epoch are checked; failed attempt consumes the proof', async () => {
  const f = await fixture(); let done;
  const received = new Promise(r => done = r);
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async (request, token) => {
      assert.throws(() => consumeHostIdentity(token, request, { ...expected(f.root), manager_epoch: 'old' }), { code: 'ROLE_STALE' });
      assert.throws(() => consumeHostIdentity(token, request, expected(f.root)), { code: 'AUTH_REQUIRED' });
      done(); return result('NO_CHANGE');
    } });
  try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); await Promise.race([received, delay(2000).then(() => assert.fail('missing call'))]); }
  finally { bridge.close(); await f.cleanup(); }
});

test('duplicate host call cannot invoke the command twice', async () => {
  const f = await fixture({ mode: 'duplicate' }); let called = 0;
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async (request, token) => { called++; consumeHostIdentity(token, request, expected(f.root)); return result('NO_CHANGE'); } });
  try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); await delay(150); assert.equal(called, 1); }
  finally { bridge.close(); await f.cleanup(); }
});

test('private isolated profile is required before launching a host', async () => {
  const f = await fixture();
  try {
    await fs.chmod(f.profile, 0o755);
    await assert.rejects(connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile, onCommand() {} }), { code: 'AUTH_DENIED' });
  } finally { await f.cleanup(); }
});

async function responseOf(f) {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await fs.readFile(path.join(f.root, 'response.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; await delay(10); }
  }
  assert.fail('missing synthetic response');
}
test('raw-byte line framing preserves multibyte command content across data chunks', async () => {
  const f = await fixture({ mode: 'utf8' });
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async (request, token) => {
      assert.equal(request.input.scope.goal, '中文🙂'); consumeHostIdentity(token, request, expected(f.root));
      return result('NO_CHANGE');
    } });
  try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); const response = await responseOf(f);
    assert.equal(JSON.parse(response.contentItems[0].text).code, 'NO_CHANGE'); }
  finally { bridge.close(); await f.cleanup(); }
});
test('handler durable pending Result is preserved; unknown failures remain INTERNAL_ERROR', async () => {
  for (const durable of [true, false]) {
    const f = await fixture();
    const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
      onCommand: async (request, token) => {
        consumeHostIdentity(token, request, expected(f.root));
        const error = new Error('private failure detail');
        if (durable) error.result = result('IO_PENDING', 'operation-a', { operation_receipt: 'operation-a',
          steps: [{ name: 'file-commit', state: 'decided', facts: { retry_same_key: true }, evidence: [], assurance: 'verified' }] });
        throw error;
      } });
    try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); const response = await responseOf(f);
      const output = JSON.parse(response.contentItems[0].text);
      assert.equal(output.code, durable ? 'IO_PENDING' : 'INTERNAL_ERROR');
      assert.equal(output.operation_receipt, durable ? 'operation-a' : null);
      assert(!JSON.stringify(response).includes('private failure detail')); }
    finally { bridge.close(); await f.cleanup(); }
  }
});
test('a handler cannot return success without consuming its identity', async () => {
  const f = await fixture();
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async () => result('NO_CHANGE') });
  try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); const response = await responseOf(f);
    assert.equal(response.success, false); assert.equal(JSON.parse(response.contentItems[0].text).code, 'AUTH_REQUIRED'); }
  finally { bridge.close(); await f.cleanup(); }
});
for (const outlet of ['return', 'attached', 'contract-error']) test(`failed identity cannot produce success through ${outlet}`, async () => {
  const f = await fixture();
  const bridge = await connectHostBridge({ executable: f.executable, home: f.root, codexHome: f.profile,
    onCommand: async (request, token) => {
      assert.throws(() => consumeHostIdentity(token, request, { ...expected(f.root), manager_epoch: 'old' }), { code: 'ROLE_STALE' });
      if (outlet === 'attached') { const error = new Error('example'); error.result = result('NO_CHANGE'); throw error; }
      if (outlet === 'contract-error') fail('NO_CHANGE');
      return result('NO_CHANGE');
    } });
  try { await bridge.bindOwnerEstablishedRoute(binding(f.root)); const response = await responseOf(f);
    assert.equal(response.success, false); assert.equal(JSON.parse(response.contentItems[0].text).code, 'AUTH_REQUIRED'); }
  finally { bridge.close(); await f.cleanup(); }
});
