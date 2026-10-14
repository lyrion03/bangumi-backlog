import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
execFileSync(process.execPath, [join(root, 'scripts', 'launcher-build.mjs')], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
});
const exe = readFileSync(join(root, 'release', 'bangumi-backlog.exe'));
const name = 'bangumi-backlog-v' + pkg.version + '-windows-x64.zip';
const bytes = zipSync(
  {
    'bangumi-backlog.exe': new Uint8Array(exe),
    'README.md': new Uint8Array(readFileSync(join(root, 'RELEASE.md'))),
  },
  { level: 9 },
);
mkdirSync(join(root, 'release'), { recursive: true });
writeFileSync(join(root, 'release', name), bytes);
const digest = (data) => createHash('sha256').update(data).digest('hex');
writeFileSync(
  join(root, 'release', 'SHA256SUMS.txt'),
  digest(exe) + '  bangumi-backlog.exe\n' + digest(bytes) + '  ' + name + '\n',
);
console.log(
  JSON.stringify({ exeBytes: exe.length, zip: name, zipBytes: bytes.length, sha256: digest(exe) }),
);
