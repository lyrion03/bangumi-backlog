import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const exe = resolve('release/bangumi-backlog.exe');
const env = { ...process.env, PORT: '4176' };
const server = spawn(exe, ['--no-open'], { env, windowsHide: true, stdio: 'ignore' });
server.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    spawnSync(exe, ['--quit'], { env, windowsHide: true, timeout: 5000 });
  });
