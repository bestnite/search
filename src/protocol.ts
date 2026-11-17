import type { ToolDefinition } from './tools.js';

/**
 * Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0, one message per line.
 * Only what this server needs is implemented — initialize, ping, tools/list and tools/call —
 * and unknown methods answer with a JSON-RPC error instead of silence.
 */
export const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);

export interface ServerInfo { name: string; version: string }

type Id = string | number | null;

interface Request { jsonrpc: '2.0'; id?: Id; method: string; params?: Record<string, unknown> }

export interface Writer { write(chunk: string): boolean }

export function createProtocol(tools: ToolDefinition[], info: ServerInfo, writer: Writer) {
  const send = (message: unknown): void => { writer.write(`${JSON.stringify(message)}\n`); };
  const result = (id: Id, value: unknown): void => send({ jsonrpc: '2.0', id, result: value });
  const fail = (id: Id, code: number, message: string, data?: unknown): void =>
    send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

  async function dispatch(request: Request, signal: AbortSignal): Promise<void> {
    const id = request.id ?? null;
    const isNotification = request.id === undefined;
    switch (request.method) {
      case 'initialize': {
        const asked = request.params?.protocolVersion;
        const version = typeof asked === 'string' && SUPPORTED.has(asked) ? asked : PROTOCOL_VERSION;
        result(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          instructions: 'Multi-backend web search. Call list_backends first to see which backends are enabled, then web_search with an explicit strategy. read_thread opens a Reddit discussion.',
        });
        return;
      }
      case 'ping': result(id, {}); return;
      case 'tools/list':
        result(id, {
          tools: tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
        return;
      case 'tools/call': {
        const name = String(request.params?.name ?? '');
        const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
        const tool = tools.find(candidate => candidate.name === name);
        if (!tool) { fail(id, -32602, `Unknown tool: ${name}`, { available: tools.map(item => item.name) }); return; }
        try {
          const value = await tool.call(args, signal);
          result(id, { content: [{ type: 'text', text: render(value) }], structuredContent: value, isError: false });
        } catch (error) {
          // A tool failure is reported inside the result, with the message the caller needs.
          result(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
        return;
      }
      default:
        if (!isNotification) fail(id, -32601, `Method not found: ${request.method}`);
    }
  }

  return {
    async handle(line: string, signal: AbortSignal): Promise<void> {
      const trimmed = line.trim();
      if (trimmed === '') return;
      let request: Request;
      try {
        request = JSON.parse(trimmed) as Request;
      } catch {
        fail(null, -32700, 'Parse error: the line is not JSON.');
        return;
      }
      if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
        fail(null, -32600, 'Invalid request.');
        return;
      }
      await dispatch(request, signal);
    },
  };
}

/** Text rendering for clients that only read content[].text. */
export function render(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (Array.isArray(record.sources)) {
      const lines: string[] = [];
      if (typeof record.report === 'string' && record.report !== '') lines.push(record.report);
      for (const source of record.sources as Array<{ title?: string; url?: string }>) {
        lines.push(`- ${source.title ?? source.url ?? ''} <${source.url ?? ''}>`);
      }
      return lines.join('\n') || 'No sources returned.';
    }
  }
  return JSON.stringify(value, null, 2);
}
