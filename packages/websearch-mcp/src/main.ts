#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, starterConfig } from './config.js';
import { createProtocol } from './protocol.js';
import { createTools, type ServerIdentity } from './tools.js';
import { watchSource } from './live.js';
import { startUi, tokenUrls } from './ui/server.js';
import { decideToken, tokenIsShort, writeTokenFile } from './ui/token.js';

const DEFAULT_UI_HOST = '127.0.0.1';
const DEFAULT_UI_PORT = 7799;
const VALUE_FLAGS = new Set(['host', 'port', 'config', 'token', 'set-token']);

function parseArgs(argv: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '-h') {
      flags.set('h', true);
      continue;
    }
    if (!argument.startsWith('--')) continue;
    const equals = argument.indexOf('=');
    if (equals > 0) {
      flags.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    if (VALUE_FLAGS.has(name) && index + 1 < argv.length) flags.set(name, argv[++index]!);
    else flags.set(name, true);
  }
  return flags;
}

async function readVersion(): Promise<string> {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const text = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(text) as { version?: unknown };
    if (typeof parsed.version === 'string') return parsed.version;
  } catch {
    // A checkout without a manifest beside dist is still usable; the version is cosmetic.
  }
  return '0.1.0';
}

const help = (): string => `websearch-mcp — MCP server for multi-backend web search

Usage
  websearch-mcp                        run over stdio (what an MCP client spawns)
  websearch-mcp --ui                   run the settings page instead of stdio
  websearch-mcp --print-config         print a starter configuration to stdout
  websearch-mcp --print-url            print the page URLs
  websearch-mcp --rotate-token         mint a random token, invalidating old links

Options
  --config <path>        configuration file (default ~/.config/websearch-mcp/config.json)
  --host <addr>          settings page bind address (default ${DEFAULT_UI_HOST}; 0.0.0.0 exposes it on every interface)
  --port <n>             settings page port (default ${DEFAULT_UI_PORT}, 0 picks a free one)
  --token <value>        use this token for this run, without saving it
  --set-token <value>    save this token and use it
  --no-token             serve the page without authentication, ignoring a saved token

Authentication
  The page needs a token only when one is configured. Precedence: --no-token, --set-token,
  --rotate-token, --token, WEBSEARCH_MCP_UI_TOKEN, then the token file beside the configuration.
  With no token anywhere the page is open: anyone who can reach the port can rewrite it.

Environment
  WEBSEARCH_MCP_CONFIG      path to config.json (default ~/.config/websearch-mcp/config.json)
  WEBSEARCH_MCP_UI_HOST     bind address for --ui
  WEBSEARCH_MCP_UI_PORT     port for --ui
  WEBSEARCH_MCP_UI_TOKEN    a token, used when no --token/--set-token/--rotate-token is given
  DSH_SEARCH_<BACKEND>_KEY  a credential; wins over the value stored in the file
  DSH_SEARCH_BROWSER_TOKEN  the browser endpoint token
`;

const argv = process.argv.slice(2);
const flags = parseArgs(argv);
const configPath = typeof flags.get('config') === 'string'
  ? String(flags.get('config'))
  : process.env.WEBSEARCH_MCP_CONFIG ?? DEFAULT_CONFIG_PATH;
const tokenFile = join(dirname(configPath), 'ui-token');

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(help());
  process.exit(0);
}

if (flags.has('print-config')) {
  process.stdout.write(`${JSON.stringify(starterConfig(), null, 2)}\n`);
  process.exit(0);
}

// stdout is the protocol channel in stdio mode: diagnostics must never touch it.
const log = (message: string): void => { process.stderr.write(`[websearch-mcp] ${message}\n`); };

const crash = (error: unknown): never => {
  if (error instanceof ConfigError) {
    log(error.message);
    for (const detail of error.details) log(`  ${detail}`);
  } else {
    log(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
};

function bindTarget(): { host: string; port: number } {
  const host = typeof flags.get('host') === 'string' ? String(flags.get('host')) : process.env.WEBSEARCH_MCP_UI_HOST ?? DEFAULT_UI_HOST;
  const raw = typeof flags.get('port') === 'string' ? String(flags.get('port')) : process.env.WEBSEARCH_MCP_UI_PORT ?? String(DEFAULT_UI_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    log(`--port needs an integer between 0 and 65535, got ${raw}`);
    process.exit(1);
  }
  return { host: host.trim() || DEFAULT_UI_HOST, port };
}

const identity: ServerIdentity = {
  name: 'websearch-mcp',
  version: await readVersion(),
  projectUrl: 'https://git.nite07.com/nite/websearch-mcp',
};

async function resolveToken(): Promise<{ token?: string; source: string }> {
  const decision = await decideToken({
    tokenFile,
    ...(typeof flags.get('token') === 'string' ? { flag: String(flags.get('token')) } : {}),
    ...(typeof flags.get('set-token') === 'string' ? { set: String(flags.get('set-token')) } : {}),
    ...(flags.has('rotate-token') ? { rotate: true } : {}),
    ...(flags.has('no-token') ? { open: true } : {}),
  });
  if (decision.persist) await writeTokenFile(tokenFile, decision.persist);
  if (decision.token && tokenIsShort(decision.token)) log(`warning: a ${decision.token.length}-character token is guessable; use --rotate-token for a random one`);
  log(`authentication: ${decision.token ? `token (${decision.source})` : 'disabled'}; ${decision.note}`);
  return { ...(decision.token === undefined ? {} : { token: decision.token }), source: decision.source };
}

const openWarning = (): void => log('no token is configured, so the page is open: anyone who can reach it can rewrite the configuration');

/**
 * --set-token and --rotate-token do one thing to the token file and print the result; with --ui they
 * are setup steps in front of a server that keeps running, so they must not exit.
 */
const wantsUi = flags.has('ui');
if (!wantsUi && (flags.has('print-url') || flags.has('rotate-token') || flags.has('set-token'))) {
  const { token } = await resolveToken();
  const { host, port } = bindTarget();
  for (const url of tokenUrls(host, port, token)) process.stdout.write(`${url}\n`);
  if (!token) openWarning();
  else log(`start the page with --ui --host ${host} --port ${port}`);
  process.exit(0);
}

if (wantsUi) {
  const { token } = await resolveToken();
  const { host, port } = bindTarget();
  try {
    const ui = await startUi({
      configPath,
      host,
      port,
      tokenFile,
      ...(token === undefined ? {} : { token }),
      version: identity.version,
      log,
    });
    if (!token) openWarning();
    log(`settings page for ${configPath}`);
    log(`listening on ${host}:${ui.port}`);
    for (const url of ui.urls) log(`open ${url}`);
    log(`token file ${tokenFile} (rotating it with --rotate-token invalidates every open link)`);
    if (ui.urls.length > 1) log('the bind is not loopback, so every address above serves the same page');
    const stop = async (): Promise<void> => { await ui.close(); process.exit(0); };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void stop());
  } catch (error) {
    crash(error);
  }
} else {
  // stdio mode: the client owns the process, and the configuration is re-read when it changes on disk.
  let config;
  try {
    config = await loadConfig({ configPath });
  } catch (error) {
    crash(error);
    throw error;
  }
  log(`ready; config ${config.configPath}`);
  const source = watchSource(config, log);
  const abort = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { source.close(); abort.abort(); process.exit(0); });

  const tools = createTools(source, identity);
  const protocol = createProtocol(tools, { name: identity.name, version: identity.version }, process.stdout);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  log(`ready with ${tools.length} tools; watching ${config.configPath}`);
  for await (const line of input) {
    if (abort.signal.aborted) break;
    await protocol.handle(line, abort.signal);
  }
  source.close();
}

