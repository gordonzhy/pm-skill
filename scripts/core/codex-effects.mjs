import { randomUUID } from 'node:crypto';
import { fail } from './contracts.mjs';
import { consumeExecutionPermit, consumeLookupPermit, recordAdapterEvidence } from './execution-permit.mjs';
import { schemaDocument } from './registry.mjs';

export function dynamicTool() {
  const schema = structuredClone(schemaDocument());
  for (const shape of schema.oneOf) {
    delete shape.properties.actor_proof;
    shape.required = shape.required.filter(k => k !== 'actor_proof');
  }
  return { type: 'function', name: 'pm_command', description: 'Submit a structured project command. Actor identity is supplied by the host.', inputSchema: schema };
}

// All mutation calls are fixed here. The client and the permit come from the
// owner-established bridge/runner, not a CLI RPC name or a model-supplied receipt.
export async function performCodexEffect(client, effect, payload, token, facts) {
  const verified = consumeExecutionPermit(token, facts);
  if (effect.id !== facts.effect_id || effect.kind !== facts.kind || effect.target !== facts.target ||
      effect.payload_digest !== facts.payload_digest || effect.claim?.id !== facts.claim_id ||
      effect.run_epoch !== facts.run_epoch || payload.id !== effect.payload_ref) fail('FENCE_INVALID');
  let outcome;
  const stamp = () => new Date().toISOString();
  const raw = randomUUID();
  try {
    if (effect.kind === 'host.prepare') {
      const created = await client.mutate('thread/start', { cwd: facts.repo, ephemeral: false,
        dynamicTools: [dynamicTool()], sandbox: 'workspace-write', approvalPolicy: 'untrusted' });
      const id = created.thread?.id;
      if (typeof id !== 'string' || !id) throw new Error('CAPABILITY_UNAVAILABLE');
      const route = { host: 'codex', instance: facts.host_instance, opaque_id: id,
        kind: 'independent-task-thread', provenance: 'host-origin' };
      client.bindCreated(id, { actor: id, role: 'executor', manager_epoch: facts.manager_epoch,
        project_id: facts.project_id, repo: facts.repo });
      const read = await client.rpc('thread/read', { threadId: id, includeTurns: false });
      if (read.thread?.id !== id) throw new Error('CAPABILITY_UNAVAILABLE');
      // Listing within a dedicated profile does not prove visibility in the user's UI.
      outcome = { state: 'confirmed', event: 'context-created', route, raw_result_ref: raw,
        visible: { value: 'unknown' }, recoverable: { value: 'unknown' } };
      const createdAt=created.thread?.createdAt;
      if(!Number.isSafeInteger(createdAt)||createdAt<0||createdAt*1000>Date.now())outcome={state:'accepted',raw_result_ref:raw};
      else outcome.occurred_at=new Date(createdAt*1000).toISOString();
    } else if (['host.start', 'host.resume', 'channel.send'].includes(effect.kind)) {
      const target = effect.target;
      const before = await client.rpc('thread/read', { threadId: target, includeTurns: effect.kind === 'channel.send' });
      if (before.thread?.id !== target) throw new Error('CAPABILITY_UNAVAILABLE');
      let response, turn;
      if (effect.kind === 'channel.send' && before.thread.status?.type === 'active') {
        const activeTurn=facts.turn_id??before.thread.turns?.filter(t=>t.status==='inProgress').at(-1)?.id;
        if (!activeTurn) fail('FENCE_INVALID');
        response = await client.mutate('turn/steer', { threadId: target, expectedTurnId: activeTurn,
          input: [{ type: 'text', text: payload.body, text_elements: [] }] });
        turn = activeTurn;
      } else {
        response = await client.mutate('turn/start', { threadId: target,
          input: [{ type: 'text', text: payload.body, text_elements: [] }], cwd: facts.repo, clientUserMessageId: effect.id });
        turn = response.turn?.id;
      }
      if (effect.kind === 'channel.send') {
        outcome = { state: 'confirmed', event: 'channel-sent', turn, occurred_at: stamp(), raw_result_ref: raw };
      } else {
        const observed = turn && await client.waitEvent(target, turn, 'turn/started');
        outcome = observed?.at ? { state: 'confirmed', event: 'turn-started', turn,
          occurred_at: observed.at, raw_result_ref: raw } : { state: 'accepted', turn, raw_result_ref: raw };
      }
    } else if (effect.kind === 'host.message') {
      if (!facts.turn_id) fail('FENCE_INVALID');
      await client.mutate('turn/steer', { threadId: effect.target, expectedTurnId: facts.turn_id,
        input: [{ type: 'text', text: payload.body, text_elements: [] }] });
      outcome = { state: 'confirmed', event: 'message-delivered', turn: facts.turn_id, occurred_at: stamp(), raw_result_ref: raw };
    } else if (effect.kind === 'host.stop') {
      if (!facts.turn_id) fail('FENCE_INVALID');
      await client.mutate('turn/interrupt', { threadId: effect.target, turnId: facts.turn_id });
      const observed = await client.waitEvent(effect.target, facts.turn_id, 'turn/completed');
      outcome = observed?.at ? { state: 'confirmed', event: 'stopped', turn: facts.turn_id,
        occurred_at: observed.at, raw_result_ref: raw } : { state: 'accepted', turn: facts.turn_id, raw_result_ref: raw };
    } else fail('CAPABILITY_UNAVAILABLE');
  } catch {
    // A lost response is not proof of failure. The original claim remains held.
    outcome = { state: 'unknown', raw_result_ref: raw };
  }
  if(outcome.occurred_at&&Date.parse(outcome.occurred_at)<Date.parse(effect.claim.claimed_at)-1000)outcome={state:'accepted',...(outcome.turn?{turn:outcome.turn}:{}),raw_result_ref:raw};
  return recordAdapterEvidence(verified, outcome);
}

// Read-only reconciliation. Unknown creation without a real route stays unknown.
export async function lookupCodexEffect(client,effect,payload,token,facts){
  const verified=consumeLookupPermit(token,facts);
  if(facts.effect_id!==effect.id||facts.claim_id!==effect.claim?.id||facts.payload_digest!==effect.payload_digest)fail('FENCE_INVALID');
  let outcome={state:'unknown',raw_result_ref:randomUUID()};
  if(effect.kind==='host.prepare')return recordAdapterEvidence(verified,outcome);
  try{
    const response=await client.rpc('thread/read',{threadId:effect.target,includeTurns:true});
    if(response.thread?.id!==effect.target)return recordAdapterEvidence(verified,outcome);
    const turns=response.thread.turns??[];
    const matches=facts.known_turn?turns.filter(t=>t.id===facts.known_turn):turns.filter(t=>t.items?.some(i=>i.type==='userMessage'&&i.id===effect.id));
    if(matches.length!==1)return recordAdapterEvidence(verified,outcome);
    const turn=matches[0],started=Number.isSafeInteger(turn.startedAt)?turn.startedAt*1000:null,completed=Number.isSafeInteger(turn.completedAt)?turn.completedAt*1000:null;
    if(['host.start','host.resume'].includes(effect.kind)&&started!==null&&started<=Date.now()&&started>=Date.parse(effect.claim.claimed_at)-1000)outcome={state:'confirmed',event:'turn-started',turn:turn.id,occurred_at:new Date(started).toISOString(),raw_result_ref:randomUUID()};
    if(effect.kind==='host.stop'&&completed!==null&&completed<=Date.now()&&completed>=Date.parse(effect.claim.claimed_at)-1000&&['completed','interrupted','failed'].includes(turn.status))outcome={state:'confirmed',event:'stopped',turn:turn.id,occurred_at:new Date(completed).toISOString(),raw_result_ref:randomUUID()};
  }catch{/* A lookup failure gives no permission to repeat the original mutation. */}
  return recordAdapterEvidence(verified,outcome);
}
