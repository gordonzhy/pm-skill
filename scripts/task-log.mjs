import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
globalThis.jsyaml=createRequire(import.meta.url)('../assets/vendor/js-yaml.min.js');
await import('../assets/task-log.js');
export const {parse,section,instant,summarize,evidenceTarget,displayEntries,timing,formatDuration,activityTimeline,offsetTime,activityGraphModel,absoluteTime}=globalThis.TaskLog;
export function inlineTaskLog(template) {
  for(const [key,file] of Object.entries({TASK_LOG_VENDOR:'vendor/js-yaml.min.js',TASK_LOG_SCRIPT:'task-log.js',TASK_LOG_CSS:'task-log.css'}))template=template.replaceAll('{{'+key+'}}',readFileSync(new URL('../assets/'+file,import.meta.url),'utf8'));
  return template;
}
// Node 会把 import.meta.url 解析为 realpath，而 process.argv[1] 保留调用时的字面路径；
// 经符号链接路径调用（安装副本、/tmp 软链等）时必须比较真实路径，否则 CLI 分支不执行。
function isMainEntry(entry) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if(isMainEntry(process.argv[1])) {
  let input='';for await(const chunk of process.stdin)input+=chunk;
  console.log(JSON.stringify(JSON.parse(input).map(text=>parse(text))));
}
