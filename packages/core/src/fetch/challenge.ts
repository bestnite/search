/**
 * Identifying a Cloudflare challenge page, and the vocabulary the browser route reports it with.
 *
 * A challenge is recognised from what the browser route already holds: the main-document status, the
 * document title, the captured DOM and the frame URLs the driver knows about. Several independent
 * markers are checked, and the bare word "cloudflare" is deliberately not one of them — a normal page
 * may mention the company, embed its script or link to its dashboard, and calling that a challenge
 * would be a false positive that hides the real page.
 *
 * Nothing here touches the network, throws, or decides an outcome. The route keeps the status it
 * observed and only adds a bounded note; solving is the route's business, not this module's.
 */

/** Title patterns Cloudflare's interstitial uses, including its Chinese wording. */
export const CHALLENGE_TITLE_PATTERNS: readonly { readonly needle: string; readonly display: string }[] = [
  { needle: 'just a moment', display: 'Just a moment' },
  { needle: 'attention required', display: 'Attention Required' },
  { needle: 'verifying you are human', display: 'Verifying you are human' },
  { needle: 'checking your browser', display: 'Checking your browser' },
  { needle: '请稍候', display: '请稍候' },
  { needle: '正在验证', display: '正在验证' },
];

/**
 * DOM needles the challenge platform writes into the document. Lowercase, because the scan lowercases
 * its window; each one is a marker of the platform, never a mention of the company.
 */
export const CHALLENGE_HTML_MARKERS: readonly string[] = [
  'cf-chl-',
  'challenge-platform',
  'challenges.cloudflare.com',
  '__cf_chl_',
  'cf_chl_opt',
  'cf-turnstile',
];

/**
 * Markers only an interstitial carries. They decide the question on their own.
 *
 * A normal page embeds Turnstile for its own login form, so the platform's script names and its widget
 * frame appear on ordinary pages too: linux.do is a forum that answers 200, renders its real content and
 * still loads challenge-platform and a challenges.cloudflare.com frame. Treating those as a challenge
 * turned a healthy page into a failed fetch.
 */
export const CHALLENGE_DECISIVE_MARKERS: readonly string[] = ['cf_chl_opt', '__cf_chl_', 'cf-chl-'];

/** Markers that only support a challenge claim when the title or the status already says so. */
export const CHALLENGE_SUPPORTING_MARKERS: readonly string[] = ['challenge-platform', 'challenges.cloudflare.com', 'cf-turnstile'];

/** A refusal is part of the claim: no status, no support from the supporting markers. */
function isRefusal(statusCode: number | undefined): boolean {
  return statusCode !== undefined && (statusCode === 403 || statusCode === 429 || statusCode >= 500);
}

/** The only host a Turnstile widget frame is served from. */
export const CHALLENGE_FRAME_HOST = 'challenges.cloudflare.com';

/** A marker scan never looks at more than this many characters of one document. */
export const CHALLENGE_SCAN_CHARS = 262_144;

/** How each marker is named in the note. One phrase per needle, so a note can never invent a marker. */
const HTML_MARKER_PHRASES: Record<string, string> = {
  'cf-chl-': 'the document carried a cf-chl marker',
  'challenge-platform': 'the document carried a challenge-platform marker',
  'challenges.cloudflare.com': 'the document referenced challenges.cloudflare.com',
  '__cf_chl_': 'the document carried a __cf_chl_ marker',
  'cf_chl_opt': 'the document carried a cf_chl_opt marker',
  'cf-turnstile': 'the document carried a cf-turnstile widget',
};

/** What the route knows about one document when it asks whether that document is a challenge. */
export interface ChallengeSignals {
  /** The main document's title, when a title could be read. */
  title?: string;
  /** Needles found in the main document, from {@link challengeHtmlMatches} or the in-page probe. */
  htmlMatches?: readonly string[];
  /** Frame URLs the driver reported; page JavaScript cannot enumerate a cross-origin frame. */
  frameUrls?: readonly string[];
  /** The main-document status. It is reported in the note and is never a marker by itself. */
  statusCode?: number;
}

export interface ChallengeDetection {
  challenge: boolean;
  /** English phrases naming the independent markers that matched, in a fixed order. */
  markers: string[];
  statusCode?: number;
}

/** The needles found in a captured document, bounded and case-folded. */
export function challengeHtmlMatches(html: string): string[] {
  const haystack = html.slice(0, CHALLENGE_SCAN_CHARS).toLowerCase();
  const found: string[] = [];
  for (const needle of CHALLENGE_HTML_MARKERS) if (haystack.includes(needle)) found.push(needle);
  return found;
}

/** Whether a frame URL is served by the challenge platform, compared by host and not by substring. */
export const isChallengeFrameUrl = (url: string): boolean => {
  try {
    return new URL(url).hostname === CHALLENGE_FRAME_HOST;
  } catch {
    return false;
  }
};

/**
 * Judge one document. True as soon as any one marker matches: a title alone identifies an
 * interstitial, and so does a challenge frame with a title still being set.
 */
export function detectCloudflareChallenge(signals: ChallengeSignals): ChallengeDetection {
  const markers: string[] = [];
  const supporting: string[] = [];
  const title = signals.title?.trim().toLowerCase() ?? '';
  let titleClaim = false;
  if (title) {
    const matched = CHALLENGE_TITLE_PATTERNS.find(pattern => title.includes(pattern.needle));
    if (matched) {
      markers.push(`the title matched "${matched.display}"`);
      titleClaim = true;
    }
  }
  const frameClaim = (signals.frameUrls ?? []).some(isChallengeFrameUrl);
  for (const needle of signals.htmlMatches ?? []) {
    const phrase = HTML_MARKER_PHRASES[needle];
    if (!phrase) continue;
    if (CHALLENGE_DECISIVE_MARKERS.includes(needle)) markers.push(phrase);
    else supporting.push(phrase);
  }
  if (frameClaim) supporting.push('a frame pointed at challenges.cloudflare.com');
  // A challenge is claimed by a title that says so, by a marker only an interstitial writes, or by
  // support that arrives together with a refusal. Embedded platform files alone claim nothing.
  const decisive = titleClaim || markers.length > 0;
  const challenge = decisive || (isRefusal(signals.statusCode) && supporting.length > 0);
  return {
    challenge,
    markers: challenge ? [...markers, ...supporting] : [],
    ...(signals.statusCode === undefined ? {} : { statusCode: signals.statusCode }),
  };
}

/**
 * The one sentence the route adds to an attempt. It names what matched, so a shield page can be told
 * apart from a plain refusal, and it reports the observed status without rewriting the outcome.
 */
export function challengeNote(detection: ChallengeDetection): string {
  const answered = detection.statusCode === undefined ? '' : ` after the main document answered HTTP ${detection.statusCode}`;
  return `The page looked like a Cloudflare challenge${answered} (${detection.markers.join(', ')}).`;
}
