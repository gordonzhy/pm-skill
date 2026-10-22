// A private, read-only worker protocol. The gateway supplies one consistent model;
// this child neither discovers projects nor owns business facts or host credentials.
import { evaluateObligations } from './obligation-monitor.mjs';
import { attentionRefreshNeeded } from './host-domain.mjs';
import { parseJSON } from './engine.mjs';

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > 16 * 1024 * 1024) process.exit(25);
  for (;;) {
    const end = buffer.indexOf(10); if (end < 0) break;
    const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
    let request;
    try {
      request = parseJSON(new TextDecoder('utf8', { fatal: true }).decode(line), { maxBytes: 16 * 1024 * 1024 });
      const { model, snapshot, generation, boot, sequence } = request;
      const evaluated = evaluateObligations(model, { snapshot, generation });
      const all = model.tasks.flatMap(task => task.execution.effects.map(effect => ({ task, effect })));
      const refresh = evaluated.roots.some(root => {
        const task = model.tasks.find(t => t.obligations.some(o => o.id === root.obligation_id));
        if (!task) return true;
        return attentionRefreshNeeded(model.project,task.execution,{...root,work_id:task.work_id});
      });
      process.stdout.write(`${JSON.stringify({ boot, sequence, refresh, roots: evaluated.roots.map(r => r.alert_key),
        ready: all.filter(({ effect }) => effect.state === 'ready').map(({ effect }) => effect.id),
        unsettled: all.filter(({ effect }) => ['claimed', 'accepted', 'unknown'].includes(effect.state)).map(({ effect }) => effect.id) })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ boot: request?.boot ?? null, sequence: request?.sequence ?? null, error: 'EVALUATION_FAILED' })}\n`);
    }
  }
});
