import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import healthHandler from '../edge-functions/api/health.js';
import protocolHandler from '../edge-functions/api/protocol.js';
import publicVersionHandler from '../edge-functions/api/public-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'dist', 'index.html'));
const mode = process.env.API_MODE || 'online';
const delayMs = Math.max(0, Number(process.env.API_DELAY_MS || 0));

const handlers = new Map([
  ['/api/health', healthHandler],
  ['/api/protocol', protocolHandler],
  ['/api/public-version', publicVersionHandler],
]);

function writeNodeResponse(res, response, bytes) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(bytes));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(html);
      return;
    }
    const handler = handlers.get(url.pathname);
    if (!handler) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (mode === 'offline') {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('access-control-allow-origin', '*');
      res.end(JSON.stringify({ ok: false, serviceId: 'cloud-collab-readonly', apiVersion: '2026-07-18', error: { code: 'TEST_OFFLINE', message: '测试服务器离线' } }));
      return;
    }
    const request = new Request(`http://127.0.0.1:${server.address().port}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
    });
    let response = await handler({ request, env: { APP_ENV: 'local-integration' }, params: {}, waitUntil() {} });
    if (mode === 'protocol2' && url.pathname === '/api/protocol') {
      const body = await response.json();
      body.data.protocolVersion = 2;
      response = new Response(JSON.stringify(body), { status: 200, headers: response.headers });
    }
    writeNodeResponse(res, response, await response.arrayBuffer());
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: String(error?.stack || error) }));
  }
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, mode, delayMs }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
