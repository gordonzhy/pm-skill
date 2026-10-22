// Trusted adapter observations stay in-process until the common file engine records them.
import { digest } from './engine.mjs';
import { fail } from './contracts.mjs';
const entries = new WeakMap();
export function recordHostObservation(observation, binding) {
  const token = Object.freeze({});
  entries.set(token, { observation: structuredClone(observation), binding: structuredClone(binding) });
  return token;
}
export function consumeHostObservation(token, observation, binding) {
  const entry = entries.get(token); entries.delete(token);
  if (!entry || digest(entry.observation) !== digest(observation) || digest(entry.binding) !== digest(binding)) fail('AUTH_DENIED');
  return entry.observation;
}
