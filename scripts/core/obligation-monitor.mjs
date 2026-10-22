// Read-only evaluation of project obligations from a verified, consistent snapshot.
// This module never sends, consumes, cancels, or satisfies an obligation.
import { fail, validate, DEFINITIONS } from './contracts.mjs';
import { digest, validateDomain } from './engine.mjs';

export function evaluateObligations(model, { snapshot, generation, now = Date.now() }) {
  validateDomain(model);
  if (!Number.isSafeInteger(now) || now < 0) fail('CLOCK_UNCERTAIN');
  const obligations = [...model.project.project_obligations, ...model.tasks.flatMap(t => t.obligations)];
  if (new Set(obligations.map(o => o.id)).size !== obligations.length) fail('INVARIANT_VIOLATION');
  const roots = [];
  let waiting = 0, active = 0, satisfied = 0, cancelled = 0;
  for (const obligation of obligations) {
    if (obligation.lifecycle === 'satisfied') { satisfied++; continue; }
    if (obligation.lifecycle === 'cancelled') { cancelled++; continue; }
    if (obligation.lifecycle === 'waiting') { waiting++; continue; }
    active++;
    if (!obligation.activated_at || !obligation.due_at ||
        !Number.isFinite(Date.parse(obligation.activated_at)) || !Number.isFinite(Date.parse(obligation.due_at)) ||
        Date.parse(obligation.due_at) < Date.parse(obligation.activated_at)) fail('INVARIANT_VIOLATION');
    if (Date.parse(obligation.activated_at) > now) fail('CLOCK_UNCERTAIN');
    if (Date.parse(obligation.due_at) > now) continue;
    const violation_kind = `overdue-${obligation.template}`;
    roots.push({
      alert_key: digest({ project_id: model.project.project_id, obligation_id: obligation.id,
        obligation_revision: obligation.obligation_revision, violation_kind }),
      obligation_id: obligation.id, obligation_revision: obligation.obligation_revision,
      violation_kind, responsible: obligation.responsible, due_at: obligation.due_at,
      // Evaluating a root establishes no delivery, consumption or business response.
      delivery: 'not-evaluated', consumption: 'not-evaluated', response: 'not-evaluated',
    });
  }
  const result = { snapshot, generation, evaluated_at: new Date(now).toISOString(),
    clock_assurance: 'owner-attested', waiting, active, satisfied, cancelled,
    roots: roots.sort((a, b) => a.alert_key.localeCompare(b.alert_key)),
    background_enabled: false, effects_performed: 0 };
  validate(result, DEFINITIONS.MonitorView);
  return result;
}
