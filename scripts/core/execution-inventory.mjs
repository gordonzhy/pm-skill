import { digest, parseJSON } from './engine.mjs';
import { fail } from './contracts.mjs';

export function parseExecutionInventory(bytes, expectedHeader) {
  try {
    if (!bytes.length || bytes.length > 16 * 1024 * 1024 || bytes.at(-1) !== 10) fail('FENCE_INVALID');
    const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes).split('\n').slice(0, -1);
    const values = lines.map(line => parseJSON(line)), header = values.shift();
    if (digest(header) !== digest(expectedHeader)) fail('FENCE_INVALID');
    let previous = digest(header);
    for (const record of values) {
      if (!record || Object.keys(record).sort().join(',') !== 'digest,previous,value' || record.previous !== previous ||
          record.digest !== digest(record.value) || !['permit', 'outcome'].includes(record.value.kind)) fail('FENCE_INVALID');
      previous = digest(record);
    }
    return values.map(record => record.value);
  } catch { fail('FENCE_INVALID'); }
}
