import type { FetchFailureKind, FetchFormat, FetchOutcomeKind, FetchRepresentation, FetchRouteKind } from './types.js';

/**
 * What one route execution produced. Every route returns this shape, so the engine can evaluate the
 * same fallback rules against HTTP, browser and provider outcomes without knowing their internals.
 *
 * `html`, `text` and `markdown` are rule inputs and output candidates: they are populated before the
 * engine converts anything and before the output is truncated, within the acquisition limits.
 */
export interface RouteResult {
  outcome: FetchOutcomeKind;
  /** True for policy, acquisition-limit and cancellation outcomes: no fallback route may take over. */
  fatal?: boolean;
  finalUrl?: string;
  /** Target main-document status, when the route learned it. Provider API status is separate. */
  statusCode?: number;
  /** Provider API HTTP status, never folded into the target status. */
  apiStatus?: number;
  representation?: FetchRepresentation;
  title?: string;
  /** Page HTML as returned or rendered: what a caller asking for HTML receives, structure preserved. */
  html?: string;
  /**
   * The conversion projection of `html`: non-content and identifiable hidden nodes removed, links
   * resolved against the final URL. Markdown derivation uses this, never the raw document.
   */
  cleanHtml?: string;
  text?: string;
  markdown?: string;
  error?: { kind: FetchFailureKind | 'policy' | 'configuration'; message: string; status?: number };
  /** Bounded explanations: delegated trust boundary, decoding fallback, conversion input cap. */
  notes: string[];
}

export const routeOk = (value: Omit<RouteResult, 'outcome' | 'notes'> & { notes?: string[] }): RouteResult => ({
  outcome: 'ok',
  notes: value.notes ?? [],
  ...value,
});

export const routeFailure = (
  outcome: FetchOutcomeKind,
  error: NonNullable<RouteResult['error']>,
  extra: Partial<Omit<RouteResult, 'outcome' | 'error'>> = {},
): RouteResult => ({ outcome, error, notes: [], ...extra });

/** Convert an acquisition into the requested representation, or report why it cannot be served. */
export interface ContentPlan {
  content?: string;
  representation?: FetchRepresentation;
  truncatedByConversionInput?: boolean;
  failure?: { outcome: FetchOutcomeKind; error: { kind: FetchFailureKind; message: string } };
}

export interface ContentOptions {
  format: FetchFormat;
  maxConversionChars: number;
  convert: (html: string) => string;
}

const textAsMarkdown = 'response-text' as FetchRepresentation;

/**
 * Produce the caller's requested representation from one successful route result.
 *
 * Markdown is native when the provider returned Markdown; it is never reconverted. HTML comes from a
 * response or a rendered DOM; a Markdown-only provider cannot serve it and is skipped earlier.
 */
export function planContent(result: RouteResult, options: ContentOptions): ContentPlan {
  const { format, maxConversionChars, convert } = options;
  if (format === 'html') {
    if (!result.html) {
      return {
        failure: {
          outcome: 'unsupported-content',
          error: { kind: 'unsupported-content', message: 'This route cannot produce the original page HTML.' },
        },
      };
    }
    return { content: result.html, representation: result.representation };
  }
  if (result.markdown !== undefined) return { content: result.markdown, representation: result.representation ?? 'provider-markdown' };
  // The projection is the sanitized, link-resolved body. Converting the raw document instead would
  // put script and hidden text into the Markdown and leave relative links unresolved.
  const projection = result.cleanHtml ?? result.html;
  if (projection !== undefined) {
    const bounded = projection.length > maxConversionChars;
    try {
      return {
        content: convert(bounded ? projection.slice(0, maxConversionChars) : projection),
        representation: result.representation,
        ...(bounded ? { truncatedByConversionInput: true } : {}),
      };
    } catch {
      return {
        failure: { outcome: 'conversion-error', error: { kind: 'conversion', message: 'The HTML could not be converted to Markdown.' } },
      };
    }
  }
  if (result.text !== undefined) return { content: result.text, representation: textAsMarkdown };
  return {
    failure: { outcome: 'unsupported-content', error: { kind: 'unsupported-content', message: 'This route produced no usable content.' } },
  };
}

/** A route request carries only what that route needs, and never the whole configuration object. */
export interface BaseRouteRequest {
  url: URL;
  format: FetchFormat;
  routeTimeoutMs: number;
  signal: AbortSignal;
}

export type RouteKind = FetchRouteKind;
