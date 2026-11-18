#!/usr/bin/env node
/**
 * The only door to the browser. Playwright itself has no auth beyond an unguessable ws path, and a
 * stable path is guessable, so this proxy holds the token: without `Authorization: Bearer <token>`
 * (or `?token=`) the upgrade is refused before it reaches the browser. Everything else is an
 * ordinary passthrough to the loopback server.
 */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const env = process.env;
const publicPort = Number(env.BROWSER_PUBLIC_PORT ?? 3000);
const endpointFile = env.BROWSER_ENDPOINT_FILE ?? '/tmp/browser-endpoint';
const profileDir = env.BROWSER_STATE_DIR ?? '/profile';
const tokenPath = join(profileDir, 'ws-token');
const wsPath = env.BROWSER_WS_PATH ?? '/ws';

/** The token is generated once per volume, so a restart keeps it and a wiped volume rotates it. */
export function resolveToken(dir = profileDir, provided = env.BROWSER_WS_TOKEN) {
  if (provided && provided.trim() !== '') return provided.trim();
  const path = join(dir, 'ws-token');
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored !== '') return stored;
  }
  const generated = randomBytes(24).toString('base64url');
  writeFileSync(path, `${generated}\n`, { mode: 0o600 });
  return generated;
}

const token = resolveToken();

const authorised = request => {
  const header = request.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    return url.searchParams.get('token') === token;
  } catch {
    return false;
  }
};

/** The browser server picks its own port, so read where it announced itself. */
function upstreamTarget() {
  try {
    const announced = readFileSync(endpointFile, 'utf8').trim();
    const url = new URL(announced);
    return { host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port), path: url.pathname };
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  if (request.url?.startsWith(wsPath)) {
    // A plain request to the websocket path is a configuration mistake worth naming.
    response.writeHead(426, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'This path speaks WebSocket. Connect with a Playwright client and an Authorization: Bearer token.' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, endpoint: `${wsPath}`, auth: 'Bearer token required', vnc: Number(env.BROWSER_VNC_PORT ?? 6080) }));
});

server.on('upgrade', (request, socket, head) => {
  if (!authorised(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const target = upstreamTarget();
  if (!target) {
    // The browser is still starting; say so instead of hanging the client.
    socket.write('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = connect(target.port, target.host, () => {
    // The Playwright server validates the upgrade against its own address: an Origin or Host that
    // names the public endpoint would be refused with 403, so both are rewritten for the upstream.
    const dropped = new Set(['authorization', 'origin', 'host']);
    const headers = Object.entries(request.headers)
      .filter(([name]) => !dropped.has(name.toLowerCase()))
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    headers.push(`host: ${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`);
    // Forward to the announced path, keeping the query string the client sent.
    const [path] = [request.url ?? '/'];
    const question = path.indexOf('?');
    const query = question >= 0 ? path.slice(question) : '';
    upstream.write(`${request.method} ${target.path}${query} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(publicPort, '0.0.0.0', () => {
  process.stderr.write(`[proxy] listening on 0.0.0.0:${publicPort}, forwarding to whatever ${endpointFile} announces (path ${wsPath})\n`);
  process.stderr.write(`[proxy] bearer token: ${token}\n`);
  process.stderr.write(`[proxy] token file: ${tokenPath} (env BROWSER_WS_TOKEN overrides it, and skips the file)\n`);
});
