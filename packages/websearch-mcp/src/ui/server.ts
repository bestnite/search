import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { catalog, SearchEngine } from '@nite07/search-core';
import { credentialResolver, loadConfig } from '../config.js';
import { renderPage } from './page.js';
import { FailureLimiter, SessionStore, SESSION_COOKIE, cookieValue, sessionCookie } from './session.js';
import { SettingsError, saveConfig, saveCredential, snapshot } from './state.js';

export interface UiOptions {
  configPath: string;
  host: string;
  port: number;
  tokenFile: string;
  /** Absent means no authentication: whoever can reach the port can rewrite the configuration. */
  token?: string;
  version: string;
  log: (message: string) => void;
}

export interface UiHandle {
  port: number;
  urls: string[];
  token?: string;
  sessions?: SessionStore;
  close(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export function displayHosts(host: string): string[] {
  if (host === '0.0.0.0' || host === '::' || host === '') {
    const external = Object.values(networkInterfaces())
      .flat()
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && entry!.family === 'IPv4' && !entry!.internal)
      .map(entry => entry.address);
    return ['127.0.0.1', ...new Set(external)];
  }
  return [host];
}

const withBrackets = (host: string): string => (host.includes(':') ? `[${host}]` : host);

export function baseUrls(host: string, port: number): string[] {
  return displayHosts(host).map(item => `http://${withBrackets(item)}:${port}`);
}

export function tokenUrls(host: string, port: number, token?: string): string[] {
  return baseUrls(host, port).map(base => (token ? `${base}/?token=${encodeURIComponent(token)}` : base));
}

export async function startUi(options: UiOptions): Promise<UiHandle> {
  let actualPort = options.port;
  const token = options.token;
  const sessions = token === undefined ? undefined : new SessionStore({ tokenFile: options.tokenFile, token });
  const limiter = new FailureLimiter();
  if (sessions) await sessions.load();

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(error => {
      options.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!response.headersSent) json(response, 500, { error: 'Internal error.' });
      else response.end();
    });
  });

  const prune = setInterval(() => sessions?.prune(), 60_000);
  prune.unref?.();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${options.port} on ${options.host} is already in use; pass --port to choose another.`)
          : error,
      );
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port, options.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  actualPort = port;

  return {
    port,
    ...(token === undefined ? {} : { token }),
    urls: tokenUrls(options.host, port, token),
    sessions,
    close: async () => {
      clearInterval(prune);
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const ip = request.socket.remoteAddress ?? 'unknown';
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);

    // A same-origin page is the only thing allowed to change state: the cookie is SameSite=Strict,
    // and a foreign Origin is refused outright rather than relying on the browser alone.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = request.headers.origin;
      if (origin && origin !== 'null') {
        let same = false;
        try {
          same = new URL(origin).host === (request.headers.host ?? '');
        } catch {
          same = false;
        }
        if (!same) return json(response, 403, { error: 'Cross-origin requests are refused.' });
      }
      const type = String(request.headers['content-type'] ?? '');
      if (!type.toLowerCase().startsWith('application/json')) return json(response, 415, { error: 'Send application/json.' });
    }

    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === '/' && method === 'GET') {
      if (!sessions) {
        const page = await renderPage();
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(page);
        return;
      }
      const candidate = url.searchParams.get('token') ?? undefined;
      if (candidate !== undefined) {
        if (limiter.blocked(ip)) return json(response, 429, { error: 'Too many failed attempts; wait five minutes.' });
        if (!sessions.verify(candidate)) {
          limiter.fail(ip);
          return text(response, 401, 'Token rejected', 'The token in this link is not the current one. Run websearch-mcp --print-url for a fresh link.');
        }
        limiter.clear(ip);
        const id = sessions.issue(ip);
        response.setHeader('Set-Cookie', sessionCookie(id, Math.floor(24 * 3600)));
        response.writeHead(303, { Location: '/' });
        response.end();
        return;
      }
      if (!sessions.check(cookieValue(request.headers.cookie, SESSION_COOKIE))) {
        return text(response, 401, 'Token required', 'Open the URL printed by websearch-mcp --print-url, or restart the service and read its log.');
      }
      const page = await renderPage();
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(page);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (sessions && !sessions.check(cookieValue(request.headers.cookie, SESSION_COOKIE))) {
        return json(response, 401, { error: 'Session expired. Reload the link from --print-url.' });
      }
      try {
        await api(method, url, request, response, options);
      } catch (error) {
        if (error instanceof SettingsError) {
          return json(response, error.status, { error: error.message, issues: error.issues });
        }
        options.log(`api ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`);
        return json(response, 500, { error: error instanceof Error ? error.message : 'Internal error.' });
      }
      return;
    }

    return json(response, 404, { error: 'Not found.' });
  }

  async function api(method: string, url: URL, request: IncomingMessage, response: ServerResponse, settings: UiOptions): Promise<void> {
    if (url.pathname === '/api/settings' && method === 'GET') {
      const current = await snapshot(settings.configPath);
      return json(response, 200, {
        ...current,
        version: settings.version,
        bound: { host: settings.host, port: actualPort },
        auth: token === undefined ? 'none' : 'token',
      });
    }
    if (url.pathname === '/api/settings' && method === 'PUT') {
      const body = await readJson(request);
      const saved = await saveConfig(settings.configPath, {
        config: (body as { config?: unknown }).config,
        compactByDefault: (body as { compactByDefault?: boolean }).compactByDefault,
        expectedRevision: (body as { expectedRevision?: string }).expectedRevision,
      });
      settings.log(`configuration saved from the page (revision ${saved.revision})`);
      return json(response, 200, { saved: true, ...saved });
    }
    if (url.pathname === '/api/credentials' && method === 'POST') {
      const body = (await readJson(request)) as Record<string, unknown>;
      const scope = body.scope === 'browser' ? 'browser' : 'backend';
      const saved = await saveCredential(settings.configPath, {
        scope,
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        ...(typeof body.value === 'string' ? { value: body.value } : {}),
        ...(body.remove === true ? { remove: true } : {}),
      });
      settings.log(`credential ${scope === 'browser' ? 'browser' : String(body.id)} ${body.remove === true ? 'removed' : 'saved'} from the page`);
      return json(response, 200, { saved: true, revision: saved.revision, state: saved.state });
    }
    if (url.pathname === '/api/test' && method === 'POST') {
      const body = (await readJson(request)) as Record<string, unknown>;
      const backendId = typeof body.backendId === 'string' ? body.backendId : '';
      const query = typeof body.query === 'string' && body.query.trim() !== '' ? body.query.trim() : 'websearch-mcp connectivity test';
      if (!catalog.some(item => item.id === backendId)) throw new SettingsError(`Unknown backend id: ${backendId || '(none)'}.`);
      const config = await loadConfig({ configPath: settings.configPath });
      const backend = config.search.backends[backendId];
      if (!backend?.enabled) throw new SettingsError(`${backendId} is disabled in the saved configuration; enable it and save first.`);
      const engine = new SearchEngine(config.search, reference => credentialResolver(config)(reference));
      try {
        const result = await engine.search({ query }, AbortSignal.timeout(30_000), backendId);
        return json(response, 200, {
          ok: true,
          text: result.content,
          sources: result.sources.slice(0, 5).map(source => ({ title: source.title, url: source.url })),
        });
      } catch (error) {
        return json(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return json(response, 404, { error: 'Not found.' });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY) throw new SettingsError('Request body is too large.');
    chunks.push(buffer);
  }
  if (!size) throw new SettingsError('A JSON body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SettingsError('The request body is not valid JSON.');
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

function text(response: ServerResponse, status: number, title: string, detail: string): void {
  const escape = (input: string): string => input.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);
  const body = `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;color:#111;background:#fff">
<h1 style="font-size:1.25rem">${escape(title)}</h1><p style="color:#555">${escape(detail)}</p></body>`;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}
