/** Where the token came from, so the log can say what is protecting (or not protecting) the page. */
export type TokenSource = 'flag' | 'env' | 'none';

export interface TokenDecision {
  /** Undefined means the page runs without authentication, as asked. */
  token?: string;
  source: TokenSource;
  note: string;
}

export interface TokenInput {
  /** --token <value> */
  flag?: string;
  /** --no-token */
  open?: boolean;
  env?: NodeJS.ProcessEnv;
}

const SHORT_TOKEN = 16;

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The token comes from the command line or the environment; this process never writes one. A page that
 * can rewrite credentials needs a secret, but a secret on disk is another copy to lose and another file
 * to mount: an operator already has to place the credentials in the configuration, so the token is
 * their call too. Unset means the page is open, which the log says plainly.
 */
export function decideToken(input: TokenInput): TokenDecision {
  if (input.open === true) return { source: 'none', note: 'authentication disabled by --no-token' };

  const flag = clean(input.flag);
  if (flag) return { token: flag, source: 'flag', note: 'token from --token' };

  const env = clean((input.env ?? process.env).WEBSEARCH_MCP_UI_TOKEN);
  if (env) return { token: env, source: 'env', note: 'token from WEBSEARCH_MCP_UI_TOKEN' };

  return { source: 'none', note: 'no token in --token or WEBSEARCH_MCP_UI_TOKEN, so the page is open' };
}

export const tokenIsShort = (token: string): boolean => token.length < SHORT_TOKEN;
