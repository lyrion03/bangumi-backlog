import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
const files = {};
function walk(dir, prefix) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(path, name);
    else files[name] = new Uint8Array(readFileSync(path));
  }
}
walk(join(root, 'dist'), 'web');
files['serve.mjs'] = new Uint8Array(readFileSync(join(root, 'scripts', 'serve.mjs')));
files['START-WINDOWS.cmd'] = strToU8(
  '@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n  echo Please install Node.js 22 LTS or later, then run this file again.\r\n  pause\r\n  exit /b 1\r\n)\r\necho Open http://127.0.0.1:4173 in your browser.\r\nnode serve.mjs\r\npause\r\n',
);
files['README.md'] = new Uint8Array(readFileSync(join(root, 'RELEASE.md')));
mkdirSync(join(root, 'release'), { recursive: true });
const name = `bangumi-backlog-v${pkg.version}.zip`;
writeFileSync(join(root, 'release', name), zipSync(files, { level: 9 }));
console.log(`Release ready: release/${name} (${Object.keys(files).length} files)`);
