/**
 * The MCP server can serve the page itself. There is no second process to install, supervise or
 * mount: the port is an environment variable on the same process that answers the MCP tools, which
 * is also the only process that already has the configuration in memory.
 */
export interface EmbeddedTarget {
  host: string;
  port: number;
}

export interface EmbeddedDecision {
  target?: EmbeddedTarget;
  /** Why the page stays off, when the variables are set but unusable. */
  error?: string;
}

export interface EmbeddedInput {
  port?: string;
  host?: string;
}

export function resolveEmbeddedUi(input: EmbeddedInput): EmbeddedDecision {
  const raw = input.port?.trim();
  if (!raw) return {};
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { error: `${raw} is not a port number between 0 and 65535` };
  }
  return { target: { host: input.host?.trim() || '127.0.0.1', port } };
}

export const embeddedFromEnv = (env: NodeJS.ProcessEnv = process.env): EmbeddedDecision =>
  resolveEmbeddedUi({
    ...(env.WEBSEARCH_MCP_UI_PORT === undefined ? {} : { port: env.WEBSEARCH_MCP_UI_PORT }),
    ...(env.WEBSEARCH_MCP_UI_HOST === undefined ? {} : { host: env.WEBSEARCH_MCP_UI_HOST }),
  });
