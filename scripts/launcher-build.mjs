import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'launcher');
const web = resolve(dir, 'web');
if (web !== join(root, 'launcher', 'web') || !web.startsWith(root + sep))
  throw Error('Unsafe asset destination');
rmSync(web, { recursive: true, force: true });
cpSync(join(root, 'dist'), web, { recursive: true });
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const numbers = version.split('.').map(Number);
if (numbers.length !== 3 || numbers.some((n) => !Number.isSafeInteger(n) || n < 0))
  throw Error('Invalid version');
const resource = readFileSync(join(dir, 'app.rc.in'), 'utf8')
  .replaceAll('@VERSION@', version)
  .replaceAll('@NUMBERS@', numbers.join(','));
writeFileSync(join(dir, 'app.rc'), resource);
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: dir, stdio: 'inherit', windowsHide: true, ...options });
run('windres', [
  '-i',
  'app.rc',
  '-o',
  'rsrc_windows_amd64.syso',
  '-O',
  'coff',
  '--target=pe-x86-64',
]);
const env = { ...process.env, CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64' };
run('go', ['test', './...'], { env });
run('go', ['vet', './...'], { env });
mkdirSync(join(root, 'release'), { recursive: true });
run(
  'go',
  [
    'build',
    '-buildvcs=false',
    '-trimpath',
    '-ldflags',
    '-s -w -H windowsgui -X main.version=' + version,
    '-o',
    join(root, 'release', 'bangumi-backlog.exe'),
    '.',
  ],
  { env },
);
console.log('Windows x64 launcher ready');
