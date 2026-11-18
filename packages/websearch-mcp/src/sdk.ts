import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { ToolDefinition } from './tools.js';

export interface ServerIdentity {
  name: string;
  version: string;
  projectUrl: string;
}

export interface ServeOptions {
  onerror?: (error: Error) => void;
}

const INSTRUCTIONS =
  'Multi-backend web search. Call list_backends first to see which backends are enabled, then web_search with an explicit strategy. read_thread opens a Reddit discussion.';

/**
 * The tool surface is read-only: every call returns remote pages and never writes anywhere the
 * caller owns. That is honest for a client that gates tools on annotations, and it is the same answer
 * for both protocol eras the SDK serves.
 */
const ANNOTATIONS: Record<string, ToolAnnotations> = {
  web_search: { readOnlyHint: true, openWorldHint: true },
  list_backends: { readOnlyHint: true, openWorldHint: false },
  read_thread: { readOnlyHint: true, openWorldHint: true },
  xiaohongshu_note: { readOnlyHint: true, openWorldHint: true },
};

/**
 * One `McpServer` per era instance. The official SDK owns the wire protocol — the handshake, the
 * stateless 2026-07-28 era, `server/discover`, validation and content framing — so a protocol
 * revision reaches this package as a dependency bump instead of a rewrite of a hand-rolled loop.
 */
export function createServer(tools: readonly ToolDefinition[], identity: ServerIdentity): McpServer {
  const server = new McpServer({ name: identity.name, version: identity.version }, { instructions: INSTRUCTIONS });
  for (const tool of tools) {
    const annotations = ANNOTATIONS[tool.name];
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
        ...(annotations ? { annotations } : {}),
      },
      async (args: unknown, context: ServerContext): Promise<CallToolResult> => {
        try {
          const value = await tool.call((args ?? {}) as Record<string, unknown>, context.mcpReq.signal);
          return resultOf(value);
        } catch (error) {
          // A tool failure belongs inside the result, where the caller can quote it.
          return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
        }
      },
    );
  }
  return server;
}

/** Serves stdio, negotiating the era per connection: modern 2026-07-28, or the 2025 handshake. */
export async function serveTools(
  tools: readonly ToolDefinition[],
  identity: ServerIdentity,
  options: ServeOptions = {},
): Promise<StdioServerHandle> {
  return serveStdio(() => createServer(tools, identity), options);
}

/** An MCP result is one text block plus one image block per picture that arrived. */
function resultOf(value: unknown): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: render(value) }];
  const images = (value as { images?: unknown } | null)?.images;
  if (Array.isArray(images)) {
    for (const image of images as Array<{ data?: unknown; mimeType?: unknown }>) {
      if (typeof image?.data === 'string' && typeof image.mimeType === 'string' && image.mimeType !== '') {
        content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
      }
    }
  }
  return { content, structuredContent: structuredCopy(value) as Record<string, unknown> };
}

/** The same value with payloads replaced by their size, for structuredContent. */
function structuredCopy(value: unknown): unknown {
  const images = (value as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) return value;
  return {
    ...(value as Record<string, unknown>),
    images: images.map(image => {
      const { data, ...rest } = image as Record<string, unknown>;
      return typeof data === 'string' ? { ...rest, inline: true } : rest;
    }),
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
