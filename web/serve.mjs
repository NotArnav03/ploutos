// Serves web/ over http, so the site can be opened without file:// quirks.
//
//   npm run site            -> http://localhost:5173
//   npm run site -- --port 8080
//
// There is no backend and the site does not want one. Every figure it shows
// is baked in by web/build.mjs from the committed run, which is the same
// property `npm run eval` has: no network, no key, same numbers every time.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = Number(process.env.PORT ?? (portFlag >= 0 ? argv[portFlag + 1] : 5173));
const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // keep the server inside web/
    const path = join(ROOT, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!path.startsWith(normalize(ROOT))) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(path);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found. Run `node web/build.mjs` first if web/index.html is missing.');
  }
}).listen(PORT, () => {
  process.stdout.write(`Ploutos site on http://localhost:${PORT}\n`);
});
