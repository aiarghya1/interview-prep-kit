/**
 * Static server for the fixture company sites, so the pipeline and the batch
 * command can be exercised against "company websites" on a local address.
 *   npm run fixtures            -> http://localhost:8099/{acme,globex,initech}/
 * {{ORIGIN}} in robots.txt / sitemaps is replaced with the server's origin.
 */
import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./sites', import.meta.url)));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

export function startFixtureServer(port = 8099): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const path = decodeURIComponent(new URL(req.url ?? '/', origin).pathname);
    if (path.startsWith('/slow/')) return; // never responds: timeout tests
    let file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const s = await stat(file);
      if (s.isDirectory()) {
        if (!path.endsWith('/')) {
          res.writeHead(301, { location: `${path}/` }).end();
          return;
        }
        file = join(file, 'index.html');
      }
      let body = await readFile(file, 'utf8');
      body = body.replaceAll('{{ORIGIN}}', origin);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
    }
  });
  return new Promise((ok) =>
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      ok({ server, origin: `http://localhost:${p}` });
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FIXTURE_PORT) || 8099;
  startFixtureServer(port).then(({ origin }) => console.log(`Fixture sites on ${origin}/{acme,globex,initech}/`));
}
