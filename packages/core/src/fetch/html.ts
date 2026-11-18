import { createDocument } from '@mixmark-io/domino';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * HTML handling for the page-fetch engine: one parse yields the title, a content-only text
 * projection and a cleaned DOM used for Markdown conversion. The returned HTML for a caller who
 * asked for structure is never this projection; see the routes.
 *
 * The functions are pure and synchronous, so the engine can bound them by input size.
 */

/** Nodes that are not content: their text never reaches the text projection or the Markdown. */
const NON_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'head', 'iframe', 'object', 'embed', 'canvas']);

export interface ParsedHtml {
  /** The document title, absent when the page had none. Never inferred from the Markdown body. */
  title?: string;
  /** Cleaned inner HTML of the body: non-content and identifiable hidden nodes removed, links resolved. */
  cleanedHtml: string;
  /** Visible-ish text of the cleaned body, whitespace normalized. */
  text: string;
  /** The URL relative links were resolved against. */
  baseUrl?: string;
}

const isHidden = (element: Element): boolean => {
  if (element.hasAttribute('hidden')) return true;
  if ((element.getAttribute('aria-hidden') ?? '').toLowerCase() === 'true') return true;
  const style = (element.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
};

/**
 * Resolve one reference against the page URL. javascript:, data: and other non-navigational schemes
 * are dropped rather than converted into a link a reader might follow.
 */
const resolveReference = (value: string, baseUrl: string | undefined): string | undefined => {
  const raw = value.trim();
  if (!raw) return undefined;
  if (raw.startsWith('#')) return raw;
  if (/^(?:javascript|data|vbscript|file|blob):/i.test(raw)) return undefined;
  if (!baseUrl) return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : undefined;
  try {
    const resolved = new URL(raw, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:' && resolved.protocol !== 'mailto:') return undefined;
    return resolved.href;
  } catch {
    return undefined;
  }
};

const RESOLVED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href'],
  area: ['href'],
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  track: ['src'],
  form: ['action'],
};

const normalizeText = (value: string | null): string =>
  (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');

/** Parse one HTML document and derive its title, text projection and cleaned body. */
export function parseHtmlDocument(html: string, finalUrl?: string, maxTitleChars = 1_000): ParsedHtml {
  const document = createDocument(html, true);
  const declaredBase = document.querySelector('base[href]')?.getAttribute('href');
  let baseUrl = finalUrl;
  if (declaredBase && finalUrl) {
    try {
      baseUrl = new URL(declaredBase, finalUrl).href;
    } catch {
      baseUrl = finalUrl;
    }
  }
  const title = normalizeText(document.title).replace(/\n/g, ' ').trim().slice(0, maxTitleChars);
  const body = document.body;
  if (!body) return { ...(title ? { title } : {}), cleanedHtml: '', text: '', ...(baseUrl ? { baseUrl } : {}) };

  for (const element of Array.from(body.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase();
    if (NON_CONTENT_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (isHidden(element)) {
      element.remove();
      continue;
    }
    const attributes = RESOLVED_ATTRIBUTES[tag];
    if (!attributes) continue;
    for (const attribute of attributes) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const resolved = resolveReference(value, baseUrl);
      if (resolved === undefined) element.removeAttribute(attribute);
      else element.setAttribute(attribute, resolved);
    }
  }

  return {
    ...(title ? { title } : {}),
    cleanedHtml: body.innerHTML,
    text: normalizeText(body.textContent),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

let service: TurndownService | undefined;

const turndown = (): TurndownService => {
  if (service) return service;
  const created = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  // GFM tables, strikethrough and task lists are what this project's readers expect to see kept.
  created.use(gfm);
  // Raw HTML blocks are inert text here, never executable markup handed back to a client.
  created.remove(['script', 'style', 'noscript', 'template', 'iframe']);
  service = created;
  return created;
};

/** Convert the cleaned body into Markdown. The caller bounds the input and the output. */
export function htmlToMarkdown(cleanedHtml: string): string {
  return turndown().turndown(cleanedHtml).trim();
}
