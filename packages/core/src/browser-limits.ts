/**
 * The local admission bound for browser reads, kept in a browser-safe module.
 *
 * The configuration schema, the settings UI and `BrowserSession` all share these numbers. They live
 * outside `browser.ts` on purpose: `browser.ts` imports patchright, and the `/static` entry that a
 * settings client bundles must never pull a browser driver in. This file has no imports at all.
 */

/** Conservative local starting point; not a Xiaohongshu quota and not verified against the site. */
export const DEFAULT_MAX_CONCURRENT_READS = 2;

export const MIN_MAX_CONCURRENT_READS = 1;

export const MAX_CONCURRENT_READS = 8;

/**
 * How many search tabs remain available for follow-up reads. Four covers several recent searches
 * without letting a long-running process accumulate pages indefinitely.
 */
export const DEFAULT_MAX_POOLED_TABS = 4;

export const MIN_POOLED_TABS = 1;

export const MAX_POOLED_TABS = 8;
