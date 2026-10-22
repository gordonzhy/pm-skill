import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateObligations } from './core/obligation-monitor.mjs';
import { initialize, reduceLocal } from './core/file-model.mjs';
import { executeFiles, emptyRevision } from './core/file-store.mjs';

const scope = { goal: 'Example', allowed_writes: ['src'], exclusions: [], criteria: ['criterion-1'] };
const stamp = Date.parse('2026-01-01T00:00:00Z');
function modelFixture() {
  const base = { protocol: 'project-files/1', repo: '/example/atlas', project_id: 'ATLAS', actor_proof: 'local-owner',
    idempotency_key: 'init', expected_revision: emptyRevision(), command: 'project init',
    input: { root: '/example/atlas', identity: 'local-owner', policy: 'policy-1' } };
  let model = initialize(base, 'op-init');
  model = reduceLocal(model, { ...base, command: 'work create', idempotency_key: 'create',
    input: { work: 'ATLAS-01', scope, label: 'Private example', deps: [], impact: [] } }, 'op-create');
  const obligation = { id: 'obligation-a', template: 'review-decision', template_version: '1',
    derivation_key: 'candidate-a', work_or_handoff_ref: 'ATLAS-01', scope_revision: 1,
    responsible: 'manager-a', activation_predicate: 'delivery', satisfaction_predicate: 'manager-decision',
    activated_at: new Date(stamp).toISOString(), due_at: new Date(stamp + 1000).toISOString(),
    policy_ref: 'policy-1', obligation_revision: 1, lifecycle: 'active', basis_refs: ['candidate-a'], next: 'decide' };
  model.tasks[0].obligations.push(obligation);
  return model;
}
const evaluate = (model, generation = 1) => evaluateObligations(model, { snapshot: 'snapshot-a', generation, now: stamp + 2000 });

test('full obligation scan includes project responsibility and nonexecuting work', () => {
  const model = modelFixture();
  model.project.project_obligations.push({ ...model.tasks[0].obligations[0], id: 'project-obligation' });
  for (const phase of ['planned', 'reviewing', 'accepted', 'closed']) {
    model.rows[0].phase = phase;
    assert.equal(evaluate(model).roots.length, 2);
  }
});
test('root identity and due date do not change with unrelated audit, generation or consumption claims', () => {
  const model = modelFixture(), original = evaluate(model);
  model.tasks[0].audit.push({ event_id: 'event-ack', at: new Date(stamp + 2000).toISOString(), actor: 'manager-a',
    type: 'attention-consumed', subject: 'obligation-a', payload: [], evidence: [] });
  model.rows[0].row_version++;
  const changed = evaluate(model, 100);
  assert.deepEqual(changed.roots, original.roots);
  assert.equal(changed.roots[0].consumption, 'not-evaluated');
  assert.equal(model.tasks[0].obligations[0].lifecycle, 'active');
  model.tasks[0].obligations[0].obligation_revision++;
  assert.notEqual(evaluate(model).roots[0].alert_key, original.roots[0].alert_key);
});
test('waiting and terminal responsibilities remain separate; evaluation never mutates source', () => {
  const model = modelFixture();
  for (const [i, lifecycle] of ['waiting', 'satisfied', 'cancelled'].entries())
    model.project.project_obligations.push({ ...model.tasks[0].obligations[0], id: `obligation-${i}`, lifecycle });
  const before = JSON.stringify(model), out = evaluate(model);
  assert.equal(JSON.stringify(model), before);
  assert.deepEqual([out.active, out.waiting, out.satisfied, out.cancelled], [1, 1, 1, 1]);
  assert.equal(out.roots.length, 1); assert.equal(out.effects_performed, 0); assert.equal(out.background_enabled, false);
});
test('invalid active dates and future activation reject without manufacturing expiry', () => {
  const model = modelFixture();
  model.tasks[0].obligations[0].due_at = 'invalid';
  assert.throws(() => evaluate(model), { code: 'INVARIANT_VIOLATION' });
  model.tasks[0].obligations[0].due_at = new Date(stamp - 1).toISOString();
  assert.throws(() => evaluate(model), { code: 'INVARIANT_VIOLATION' });
  model.tasks[0].obligations[0].activated_at = new Date(stamp + 3000).toISOString();
  model.tasks[0].obligations[0].due_at = new Date(stamp + 4000).toISOString();
  assert.throws(() => evaluate(model), { code: 'CLOCK_UNCERTAIN' });
});
test('monitor query reuses consistent FileStore snapshot, enforces exact token, and is read-only', { skip: process.platform !== 'darwin' }, async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'monitor-query-')));
  const repo = path.join(base, 'repo'), state = path.join(base, 'state');
  await fs.mkdir(repo, { mode: 0o700 }); await fs.mkdir(state, { mode: 0o700 });
  let revision = emptyRevision(), sequence = 0;
  const command = async (command, input, options = {}) => {
    const request = { protocol: 'project-files/1', repo, project_id: 'ATLAS', actor_proof: 'local-owner',
      idempotency_key: `request-${++sequence}`, expected_revision: revision, command, input };
    const result = await executeFiles(request, { state, ...options });
    if (result.source_revision) revision = result.source_revision;
    return result;
  };
  const query = extra => executeFiles({ protocol: 'project-files/1', repo, query: 'snapshot', projection: 'private-local',
    snapshot_token: null, input: {}, ...extra }, { state });
  const tree = async () => {
    const files = {};
    async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else files[p] = (await fs.readFile(p)).toString('base64');
    } } await walk(base); return files;
  };
  try {
    await command('project init', { root: repo, identity: 'local-owner', policy: 'policy-1' });
    await command('work create', { work: 'ATLAS-01', scope, label: 'Private label', deps: [], impact: [] });
    const snapshot = await query(), request = { query: 'monitor evaluate', input: { snapshot: snapshot.snapshot, policy: 'policy-1' } };
    const before = await tree();
    const evaluated = await query(request);
    assert.equal(evaluated.data.monitor.snapshot, snapshot.snapshot);
    assert.equal(evaluated.data.monitor.generation, snapshot.generation);
    assert.deepEqual(await tree(), before);
    const summary = await query({ ...request, projection: 'summary' });
    assert(!JSON.stringify(summary).includes('Private label')); assert(!summary.data.monitor);
    await assert.rejects(query({ ...request, input: { ...request.input, snapshot: 'other-snapshot' } }), { code: 'VERSION_CONFLICT' });
    await assert.rejects(query({ ...request, input: { ...request.input, policy: 'other-policy' } }), { code: 'AUTH_DENIED' });
    await assert.rejects(query({ ...request, input: { ...request.input, observations: ['untrusted'] } }), { code: 'CAPABILITY_UNAVAILABLE' });
    const failed = await command('work create', { work: 'ATLAS-02', scope, label: 'Second', deps: [], impact: [] },
      { fault: async n => { if (n === 'DECIDED') throw new Error('injected interruption'); } });
    assert.equal(failed.code, 'IO_PENDING');
    const dirtyBefore = await tree();
    await assert.rejects(query(request), { code: 'RECOVERY_REQUIRED' });
    assert.deepEqual(await tree(), dirtyBefore);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
