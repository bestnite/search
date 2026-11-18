import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/** Where the token came from, so the log can say what is protecting (or not protecting) the page. */
export type TokenSource = 'flag' | 'env' | 'file' | 'rotated' | 'set' | 'none';

export interface TokenDecision {
  /** Undefined means the page runs without authentication, as asked. */
  token?: string;
  source: TokenSource;
  /** A value to write to the token file; only rotation and --set-token persist. */
  persist?: string;
  note: string;
}

export interface TokenInput {
  tokenFile: string;
  /** --token <value> */
  flag?: string;
  /** --set-token <value> */
  set?: string;
  /** --no-token */
  open?: boolean;
  /** --rotate-token */
  rotate?: boolean;
  env?: NodeJS.ProcessEnv;
  read?: (path: string) => Promise<string | undefined>;
  mint?: () => string;
}

const SHORT_TOKEN = 16;

async function readTokenFile(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf8')).trim();
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export async function writeTokenFile(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Precedence: an explicit --no-token beats everything, then --set-token, --rotate-token, --token,
 * the environment, and finally the file. Nothing is minted behind the caller's back: an unset token
 * means the page is open, which is what "no token configured" has to mean to be predictable.
 */
export async function decideToken(input: TokenInput): Promise<TokenDecision> {
  const read = input.read ?? readTokenFile;
  if (input.open === true) {
    return { source: 'none', note: 'authentication disabled by --no-token' };
  }

  const set = clean(input.set);
  if (set) return { token: set, source: 'set', persist: set, note: 'token set by --set-token and saved' };

  if (input.rotate === true) {
    const minted = (input.mint ?? (() => randomBytes(32).toString('base64url')))();
    return { token: minted, source: 'rotated', persist: minted, note: 'token rotated and saved' };
  }

  const flag = clean(input.flag);
  if (flag) return { token: flag, source: 'flag', note: 'token from --token (not saved)' };

  const env = clean((input.env ?? process.env).WEBSEARCH_MCP_UI_TOKEN);
  if (env) return { token: env, source: 'env', note: 'token from WEBSEARCH_MCP_UI_TOKEN (not saved)' };

  const file = await read(input.tokenFile);
  if (file) return { token: file, source: 'file', note: `token from ${input.tokenFile}` };

  return { source: 'none', note: 'no token configured, so the page is open' };
}

export const tokenIsShort = (token: string): boolean => token.length < SHORT_TOKEN;
