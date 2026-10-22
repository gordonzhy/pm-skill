// In-process handoff between the fenced runner and its owner-selected adapter.
// Never serialized and never accepted as a CLI field or a reusable bearer token.
import { fail } from './contracts.mjs';
import { digest } from './engine.mjs';

const permits = new WeakMap();
const lookups = new WeakMap();
const consumed = new WeakSet();
const evidence = new WeakMap();
export function issueExecutionPermit(facts, live) {
  if (typeof live !== 'function' || !facts?.claim_id || !facts.connection) fail('FENCE_INVALID');
  const token = Object.freeze({});
  permits.set(token, { facts: structuredClone(facts), deadline: performance.now() + 5000, live });
  return token;
}
export function consumeExecutionPermit(token, facts) {
  const permit = permits.get(token); permits.delete(token);
  if (!permit || !permit.live() || performance.now() > permit.deadline || digest(permit.facts) !== digest(facts)) fail('FENCE_INVALID');
  const factsCopy = Object.freeze(structuredClone(permit.facts));
  consumed.add(factsCopy); return factsCopy;
}

export function recordAdapterEvidence(facts, outcome) {
  if (!consumed.has(facts)) fail('FENCE_INVALID');
  consumed.delete(facts);
  if (!['confirmed', 'accepted', 'unknown', 'failed'].includes(outcome?.state)) fail('INVALID_INPUT');
  const token = Object.freeze({});
  evidence.set(token, { facts, outcome: structuredClone(outcome) });
  return token;
}
export function consumeAdapterEvidence(token, expected) {
  const entry = evidence.get(token); evidence.delete(token);
  if (!entry || digest(entry.facts) !== digest(expected)) fail('FENCE_INVALID');
  return structuredClone(entry.outcome);
}
export function inspectAdapterEvidence(token, expected) {
  const entry = evidence.get(token);
  if (!entry || digest(entry.facts) !== digest(expected)) fail('FENCE_INVALID');
  return structuredClone(entry.outcome);
}
export function issueLookupPermit(facts, live) {
  if (typeof live !== 'function' || !facts?.claim_id) fail('FENCE_INVALID');
  const token = Object.freeze({}); lookups.set(token, { facts: structuredClone(facts), live }); return token;
}
export function consumeLookupPermit(token, facts) {
  const entry = lookups.get(token); lookups.delete(token);
  if (!entry || !entry.live() || digest(entry.facts) !== digest(facts)) fail('FENCE_INVALID');
  const value = Object.freeze(structuredClone(facts)); consumed.add(value); return value;
}
