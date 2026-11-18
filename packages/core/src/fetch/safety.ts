import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MAX_URL_LENGTH } from './limits.js';
import { PageFetchError } from './types.js';

/** A target URL this fetch refuses to touch. It is fatal: no fallback route may take over. */
export class FetchPolicyError extends Error {
  readonly kind = 'policy';
  constructor(message: string) {
    super(message);
    this.name = 'FetchPolicyError';
  }
}

/** Addresses are resolved through this indirection so tests never depend on real DNS. */
export type AddressResolver = (hostname: string) => Promise<string[]>;

export const systemResolver: AddressResolver = async hostname => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
};

/**
 * Parse and shape-check a caller-supplied URL. This runs before any network access: a malformed
 * value, a non-HTTP scheme and an embedded credential are input errors, not route failures.
 */
export function parseTargetUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.trim() === '') throw new PageFetchError('invalid-input', 'A page URL is required.');
  if (raw.length > MAX_URL_LENGTH) throw new PageFetchError('invalid-input', `A page URL must be at most ${MAX_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PageFetchError('invalid-input', 'The page URL is not a valid absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageFetchError('invalid-input', 'Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new PageFetchError('invalid-input', 'URLs with embedded credentials are refused.');
  if (!url.hostname) throw new PageFetchError('invalid-input', 'The page URL has no host.');
  return url;
}

const parseIpv4Dotted = (value: string): number | undefined => {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
};

/**
 * Expand one IPv6 literal into eight 16-bit groups. The dotted-quad tail is decoded too, because a
 * browser normalizes `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1` before anything here sees it.
 */
const parseIpv6Groups = (address: string): number[] | undefined => {
  const value = address.split('%')[0]!;
  if (!value.includes(':')) return undefined;
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const embedded = parseIpv4Dotted(group);
        if (embedded === undefined) return undefined;
        groups.push((embedded >>> 16) & 0xffff, embedded & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0]!);
  if (!left) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const right = parseGroups(halves[1]!);
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
};

/**
 * The IPv4 address carried by a mapped, compatible or NAT64 IPv6 literal, if any.
 *
 * `::ffff:0:0/96` (mapped), `::0.0.0.0/96` (compatible), and `64:ff9b::/96` plus `64:ff9b:1::/48`
 * (NAT64) all put the last 32 bits where an IPv4 address would be.
 */
const embeddedIpv4 = (groups: readonly number[]): number | undefined => {
  if (groups.length !== 8) return undefined;
  const [first, second, third, fourth, fifth, sixth, seventh, eighth] = groups as [number, number, number, number, number, number, number, number];
  const last = ((seventh << 16) | eighth) >>> 0;
  const mapped = first === 0 && second === 0 && third === 0 && fourth === 0 && (fifth === 0 || fifth === 0xffff);
  const nat64 = first === 0x64 && second === 0xff9b;
  return mapped || nat64 ? last : undefined;
};

const dottedIpv4 = (value: number): string => `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;

const privateIpv4Number = (value: number): boolean => privateIpv4(dottedIpv4(value));

const privateIpv4 = (address: string): boolean => {
  const value = parseIpv4Dotted(address);
  // Anything unparseable is unsafe rather than public.
  if (value === undefined) return true;
  const a = (value >>> 24) & 0xff;
  const b = (value >>> 16) & 0xff;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
};

const privateIpv6 = (address: string): boolean => {
  const groups = parseIpv6Groups(address);
  if (!groups) return true;
  // An embedded IPv4 address inherits the policy of the address it carries, whatever notation the
  // browser or resolver used: dotted, hex, mapped, compatible or NAT64.
  const embedded = embeddedIpv4(groups);
  if (embedded !== undefined) return privateIpv4Number(embedded);
  if (groups.every(group => group === 0)) return true;
  if (groups[0] === 0xfc00 || (groups[0]! & 0xfe00) === 0xfc00) return true;
  if ((groups[0]! & 0xffc0) === 0xfe80) return true;
  if ((groups[0]! & 0xff00) === 0xff00) return true;
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
  return false;
};

/** Loopback, private, link-local, CGNAT, multicast, reserved and metadata ranges. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  // Anything unparseable is treated as unsafe rather than as a public address.
  return true;
}

const localHostname = (hostname: string): boolean => {
  const value = hostname.toLowerCase().replace(/\.$/, '');
  return value === 'localhost' || value.endsWith('.localhost') || value.endsWith('.local') || value.endsWith('.internal') || value === 'metadata.google.internal';
};

/**
 * Apply the target policy uniformly to the first URL and to every redirect hop.
 *
 * With `allowPrivateNetworks` off, a literal private address or a private name is refused locally and
 * every resolved address has to be public. A remote browser or provider resolves the name elsewhere,
 * so this preflight cannot prove its destination: enabling such a route is the delegated decision,
 * its result says so, and no weaker check is reported as a stronger one.
 */
export async function assertTargetPolicy(url: URL, allowPrivateNetworks: boolean, resolver: AddressResolver): Promise<void> {
  if (allowPrivateNetworks) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (localHostname(hostname)) throw new FetchPolicyError('The target is a local host name; public-only fetching refuses it.');
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new FetchPolicyError('The target is a private or reserved address; public-only fetching refuses it.');
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new FetchPolicyError('The target host name did not resolve, so it cannot be checked against the public-only policy.');
  }
  if (!addresses.length) throw new FetchPolicyError('The target host name resolved to no address.');
  const blocked = addresses.filter(address => isPrivateAddress(address));
  if (blocked.length) throw new FetchPolicyError('The target resolves to a private or reserved address; public-only fetching refuses it.');
}

/**
 * The part of the target policy that needs no name resolution: a local host name or a literal
 * private address is refused even for a delegated route. It runs before any route request.
 */
export function assertLiteralTargetPolicy(url: URL, allowPrivateNetworks: boolean): void {
  if (allowPrivateNetworks) return;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (localHostname(hostname)) throw new FetchPolicyError('The target is a local host name; public-only fetching refuses it.');
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new FetchPolicyError('The target is a private or reserved address; public-only fetching refuses it.');
  }
}
