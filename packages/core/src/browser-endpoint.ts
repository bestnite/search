/**
 * A Playwright browser endpoint is a WebSocket URL and nothing else. This check is deliberately
 * protocol-only: the host is never restricted, because a browser container may be addressed through
 * a runtime alias, a LAN name or a tunnel.
 */
export function parseBrowserEndpoint(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash || url.search) return undefined;
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
