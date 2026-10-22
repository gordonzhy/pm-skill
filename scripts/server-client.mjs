import os from 'node:os';
import path from 'node:path';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
export const passwordPath = stateDir => path.join(stateDir, 'password.txt');
export const authorizationFor = password => 'Basic '+Buffer.from('admin:'+password, 'utf8').toString('base64');

// 密码仅留在运行状态目录；拒绝符号链接、宽松权限和空文件，绝不回退为匿名访问。
export async function readPassword(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 4096) throw new Error('密码文件必须是仅本人可读写的普通文件（chmod 600）');
    const password = (await file.readFile('utf8')).replace(/\r?\n$/, '');
    if (password.length < 16 || /[\r\n\x00]/.test(password)) throw new Error('密码文件必须包含至少16个字符的单行密码');
    return password;
  } finally { await file.close(); }
}

export function serverStateDir(){
 if(process.env.PM_SERVER_STATE_DIR)return path.resolve(process.env.PM_SERVER_STATE_DIR);
 if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','pm-server');
 if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'pm-server');
 return path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local','state'),'pm-server');
}
