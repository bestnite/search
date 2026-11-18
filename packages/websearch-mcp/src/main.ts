#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { ConfigError, loadConfig, starterConfig } from './config.js';
import { createProtocol } from './protocol.js';
import { createTools, type ServerIdentity } from './tools.js';

const identity: ServerIdentity = {
  name: 'websearch-mcp',
  version: process.env.npm_package_version ?? '0.1.0',
  projectUrl: 'https://git.nite07.com/nite/websearch-mcp',
};

const argv = process.argv.slice(2);
const args = new Set(argv);
/** --config <path> wins over WEBSEARCH_MCP_CONFIG, which wins over the default location. */
const configFlag = (() => { const index = argv.indexOf('--config'); return index >= 0 ? argv[index + 1] : undefined; })();

if (args.has('--help') || args.has('-h')) {
  process.stdout.write(`websearch-mcp — MCP server for multi-backend web search

Usage
  websearch-mcp                 run over stdio
  websearch-mcp --print-config  print a starter configuration to stdout
  websearch-mcp --config <path> use a specific configuration file

Environment
  WEBSEARCH_MCP_CONFIG          path to config.json (default ~/.config/websearch-mcp/config.json)
`);
  process.exit(0);
}

if (args.has('--print-config')) {
  process.stdout.write(`${JSON.stringify(starterConfig(), null, 2)}\n`);
  process.exit(0);
}

// stdout is the protocol channel: diagnostics must never touch it.
const log = (message: string): void => { process.stderr.write(`[websearch-mcp] ${message}\n`); };

const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { abort.abort(); process.exit(0); });

let protocol: ReturnType<typeof createProtocol> | undefined;
try {
  const config = await loadConfig({ ...(configFlag ? { configPath: configFlag } : {}) });
  const tools = createTools(config, identity);
  protocol = createProtocol(tools, { name: identity.name, version: identity.version }, process.stdout);
  log(`ready with ${tools.length} tools; config ${config.configPath}`);
} catch (error) {
  // The server still answers initialize/tools/list, but every search would fail, so say why on
  // stderr and refuse to pretend: the client sees a clean exit instead of a half-working server.
  if (error instanceof ConfigError) {
    log(error.message);
    for (const detail of error.details) log(`  ${detail}`);
  } else {
    log(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) await protocol.handle(line, abort.signal);
