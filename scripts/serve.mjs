import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(root, 'web');
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = path.resolve(
      site,
      '.' + (pathname.endsWith('/') ? pathname + 'index.html' : pathname),
    );
    if (!target.startsWith(site + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405).end();
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(target)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(target));
  } catch {
    res.writeHead(404).end('Not found');
  }
});
server.on('error', (err) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `Port ${port} is in use. Set PORT to another port and retry.`
      : err.message,
  );
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () =>
  console.log(
    `bangumi-backlog is ready: http://127.0.0.1:${port}\nKeep this window open. Press Ctrl+C to stop.`,
  ),
);
