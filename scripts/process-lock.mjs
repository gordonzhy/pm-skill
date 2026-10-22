// POSIX 内核锁：锁文件永久保留；Python 持锁到 Node 关闭管道或退出。
// 不按文件年龄抢占活锁，不删除锁 inode，避免回收竞争造成双持有者。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const helper = String.raw`
import errno, fcntl, json, os, stat, sys, time
filename, timeout, parent = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
fd = os.open(filename, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    raise RuntimeError('lock must be a regular file; legacy directory lock requires an explicit quiescent migration: ' + filename)
deadline = time.monotonic() + timeout
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # 旧文件锁有完整活 PID 时，不能与旧版并跑；无身份旧目录在 open 时即拒绝。
        os.lseek(fd, 0, os.SEEK_SET)
        try: previous = json.loads(os.read(fd, 4096))
        except (ValueError, UnicodeDecodeError): previous = {}
        if isinstance(previous, int): previous = {"pid": previous}
        if not isinstance(previous, dict): previous = {}
        owner = previous.get('pid') if isinstance(previous, dict) else None
        if previous.get('protocol') != 'flock-v1' and isinstance(owner, int) and owner > 0:
            try: os.kill(owner, 0); live = True
            except ProcessLookupError: live = False
            except PermissionError: live = True
            if live:
                fcntl.flock(fd, fcntl.LOCK_UN)
                raise BlockingIOError('legacy live lock owner')
        break
    except BlockingIOError:
        if time.monotonic() >= deadline: raise TimeoutError('timed out waiting for process lock: ' + filename)
        time.sleep(0.025)
os.ftruncate(fd, 0)
os.lseek(fd, 0, os.SEEK_SET)
os.write(fd, json.dumps({'protocol': 'flock-v1', 'pid': parent, 'helperPid': os.getpid()}).encode())
sys.stdout.write('LOCKED\n'); sys.stdout.flush()
while sys.stdin.buffer.read(8192): pass
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;
export async function runtimeLockPath(repository) {
  const canonical = await realpath(repository);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `project-manager-task-runtime-${key}.lock`);
}
export async function acquireProcessLock(filename, {timeoutMs = 5000} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('invalid process lock timeout');
  await mkdir(path.dirname(filename), {recursive: true, mode: 0o700});
  filename = path.join(await realpath(path.dirname(filename)), path.basename(filename));
  try {if ((await lstat(filename)).isDirectory()) throw new Error(`legacy directory lock requires an explicit quiescent migration: ${filename}`);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  const child = spawn(process.env.PYTHON || 'python3', ['-u', '-c', helper, filename, String(timeoutMs / 1000), String(process.pid)], {stdio: ['pipe', 'pipe', 'pipe']});
  let acquired = false, releasing = false, ended = false, output = '', errors = '';
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => {errors = (errors + chunk).slice(-8000);});
  const closed = new Promise(resolve => child.once('close', resolve));
  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
    child.once('error', error => {clearTimeout(startupTimer); reject(error);});
    child.stdout.on('data', chunk => {output += chunk; if (!acquired && output.includes('LOCKED\n')) {acquired = true; clearTimeout(startupTimer); resolve();}});
    child.once('exit', (code, signal) => {
      clearTimeout(startupTimer); ended = true;
      if (!acquired) reject(new Error(`process lock unavailable (${code ?? signal}): ${filename}: ${errors.trim()}`));
      else if (!releasing) {
        // 锁帮助进程异常丢失时不能继续提交事务；关闭整个写入者以停止后续 JS 操作。
        process.stderr.write(`fatal: process lock lost: ${filename}\n`); process.exit(1);
      }
    });
  });
  return {pid: child.pid, filename, async release() {
    if (releasing) return;
    releasing = true;
    if (ended) throw new Error(`process lock was lost: ${filename}`);
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try {const code = await closed; if (code !== 0) throw new Error(`process lock release failed: ${filename}`);} finally {clearTimeout(timer);}
  }};
}
export async function withProcessLock(filename, action, options) {
  const lock = await acquireProcessLock(filename, options);
  try {return await action();} finally {await lock.release();}
}
