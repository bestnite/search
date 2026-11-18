import { parseBrowserEndpoint, parseConfig, sameConfig } from '@nite07/search-core/static';
import type { ConfigIssue, SearchConfig } from '@nite07/search-core/static';

/**
 * Presentation rules that do not need a DOM: which tab owns a configuration path, where an issue
 * should land the user, and the front-end half of the browser save gate.
 *
 * These live outside the React module so they can be unit-tested directly. The server re-checks the
 * same gate authoritatively before writing; this layer only explains the cause before a click.
 */

export type SettingsTab = 'behavior' | 'reliability' | 'diagnostics' | 'backends' | 'browser' | 'fetch';

/** The control-id scheme shared by the page and the focus resolver. */
export const fieldId = (path: string): string => `nite-search-${path.replace(/[^a-z0-9-]/gi, '-')}`;

/**
 * Whether a provider's single credential control has to be rendered.
 *
 * A keyed search mode needs it, and so does a declared keyed fetch mode even while search stays
 * keyless — otherwise a keyed fetch would have no place to enter the key. A browser-backed search
 * mode uses the shared browser token instead, and a provider whose catalog entry declares no fetch
 * operation is never keyed for fetching, whatever its inert fetch record says.
 */
export function needsCredentialControl(input: { searchMode: string; fetchMode?: string; fetchModes: readonly string[] }): boolean {
  const searchNeeds = input.searchMode !== 'anonymous' && input.searchMode !== 'browser';
  const fetchMode = input.fetchMode ?? 'anonymous';
  // Only a mode the fetch operation actually declares counts: a provider without one keeps an inert
  // fetch record carrying its first search mode, which must never ask for a key.
  const fetchNeeds = input.fetchModes.includes(fetchMode) && fetchMode !== 'anonymous';
  return searchNeeds || fetchNeeds;
}

/**
 * The one credential input of a backend, which lives on its search card. The Page fetch tab links to
 * this exact control instead of rendering a second key field, so a keyed fetch mode and a keyed search
 * mode share one place to enter the key.
 */
export const credentialFieldId = (backendId: string): string => `secret-${backendId}`;

/** The tab a path belongs to. Fetch-only browser options stay on the Fetch tab, never the Browser tab. */
export function tabForPath(path: string): SettingsTab {
  if (path === 'backends' || path === 'sec-backends') return 'backends';
  if (path.startsWith('browser.')) return 'browser';
  // pageFetch.browser.* (context, settle, selector) describes the fetch operation, not the shared browser.
  if (path.startsWith('pageFetch')) return 'fetch';
  if (/^backends\.[^.]+\.fetch\./.test(path)) return 'fetch';
  if (path.startsWith('backends.')) return 'backends';
  if (path.startsWith('retry.') || path.startsWith('breaker.') || path.startsWith('cache.') || path === 'diagnostics.enabled' || path === 'diagnostics.maxEntries') return 'reliability';
  return 'behavior';
}

/**
 * The tab and focus target for a path. Provider fetch fields open the Fetch tab, where the provider
 * card lives; a browser-route failure jumps to the shared browser endpoint that must be filled in.
 */
export function focusForPath(path: string): { tab: SettingsTab; target: string } {
  if (path === 'backends' || path === 'sec-backends') return { tab: 'backends', target: 'sec-backends' };
  // A credential input is addressed by its element id, because it is not a configuration path: a
  // keyed fetch mode links to the search card's one key field rather than to any field of its mode.
  if (path.startsWith('secret-')) return { tab: 'backends', target: path };
  if (path === 'browser' || path === 'sec-browser') return { tab: 'browser', target: 'browser.endpoint' };
  if (path.startsWith('browser.')) return { tab: 'browser', target: path };
  if (path === 'pageFetch.routes' || path === 'pageFetch') return { tab: 'fetch', target: 'sec-fetch-routes' };
  if (path.startsWith('pageFetch')) return { tab: 'fetch', target: path };
  if (/^backends\.[^.]+\.fetch\./.test(path)) return { tab: 'fetch', target: path };
  if (path.startsWith('backends.')) return { tab: 'backends', target: path };
  return { tab: tabForPath(path), target: path };
}

/** The HTTP answer to a save request, or the fact that the request never produced one. */
export interface SaveResponse { status: number; payload: any }
export type SaveReadback = { ok: true; matches: boolean } | { ok: false };

/**
 * Whether the saved state read back after a save attempt is the configuration that attempt wrote.
 *
 * This replaces comparing the two configurations as JSON text. A saved row written by an older
 * release carries its newer blocks at the end; the running instance holds them in schema order, so
 * both shapes describe the same configuration while their text differs. Comparing that text
 * announced a conflict for a write that had landed, and the user was told to review a draft that was
 * already saved.
 *
 * The revision the server returns for the written candidate is authoritative when both sides supply
 * one: a read-back reporting that revision is the written configuration, and any other revision is a
 * genuinely different saved state (a later save, a refusal, or a restart that did not apply it). When
 * only the values are available they are compared canonically, with array order kept intact.
 *
 * A value that cannot be canonicalized throws: a read-back that cannot be represented is reported as
 * unknown by the caller, never as equal.
 */
export function readbackMatches(input: { saved: SearchConfig; intended: SearchConfig; savedRevision?: string; writtenRevision?: string }): boolean {
  if (input.writtenRevision !== undefined && input.savedRevision !== undefined) return input.writtenRevision === input.savedRevision;
  let normalized = input.intended;
  try { normalized = parseConfig(input.intended); } catch { /* the served configuration is still compared, never skipped */ }
  return sameConfig(input.saved, normalized);
}

/**
 * Whether a draft still differs from the served configuration, regardless of key order.
 *
 * Both sides come from JSON, so canonicalization cannot fail in practice. If it ever did, the draft
 * is reported as different rather than as saved: a page that cannot compare its own state must not
 * claim there is nothing left to save.
 */
export function sameDraft(draft: SearchConfig, saved: SearchConfig): boolean {
  try { return sameConfig(draft, saved); } catch { return false; }
}

/**
 * What a save attempt actually proved. A definite rejection (400) happens before any write; a 5xx or
 * a lost response says nothing on its own, so only a successful read-back may claim a result. A
 * failed read-back is `state-unknown`, never a fabricated "nothing was written".
 */
export type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'rejected'; code: string; issues: ConfigIssue[] }
  | { kind: 'conflict' }
  | { kind: 'write-failed'; code: string; message: string }
  | { kind: 'unconfirmed' }
  | { kind: 'state-unknown' };

export function classifySaveOutcome(input: { response?: SaveResponse; transportError?: boolean; readback?: SaveReadback }): SaveOutcome {
  const readback = input.readback;
  const payload = input.response?.payload;
  const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'operation-failed';
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : '';
  if (input.response) {
    const status = input.response.status;
    if (status >= 200 && status < 300) {
      if (!readback) return { kind: 'state-unknown' };
      if (!readback.ok) return { kind: 'state-unknown' };
      return readback.matches ? { kind: 'saved' } : { kind: 'conflict' };
    }
    if (status === 409) return { kind: 'conflict' };
    if (status === 400) {
      const issues = Array.isArray(payload?.error?.issues) ? payload.error.issues as ConfigIssue[] : [];
      return { kind: 'rejected', code, issues };
    }
    // Any other answer is a server-side failure: read the state back before saying anything about
    // whether the write landed.
    if (!readback) return { kind: 'state-unknown' };
    if (!readback.ok) return { kind: 'state-unknown' };
    if (readback.matches) return { kind: 'saved' };
    return { kind: 'write-failed', code, message };
  }
  if (!readback) return { kind: 'state-unknown' };
  if (!readback.ok) return { kind: 'state-unknown' };
  return readback.matches ? { kind: 'saved' } : { kind: 'unconfirmed' };
}

/**
 * The backend id a focus target belongs to, when it is inside a backend card.
 *
 * A credential input is addressed by its element id (`secret-<backend>`), so a link from the Page fetch
 * tab still knows which backend card has to be shown before it can be focused.
 */
export function backendIdForPath(path: string): string | undefined {
  const match = /^backends\.([^.]+)\./.exec(path) ?? /^secret-(.+)$/.exec(path);
  return match?.[1];
}

/** A backend filter hides the card that owns the issue; the focus effect has to reset it first. */
export function shouldResetBackendFilter(path: string, query: string, filter: string): boolean {
  return Boolean(backendIdForPath(path)) && (query !== '' || filter !== 'all');
}

/** The minimal element surface the focus walk needs, so it can be driven by a fake DOM in tests. */
export interface FocusableNode {
  closest(selector: string): FocusableNode | null;
  parentElement: FocusableNode | null;
  scrollIntoView?(options: { block: string }): void;
  focus?(): void;
  open?: boolean;
}
export interface FocusDocument { getElementById(id: string): FocusableNode | null }

/**
 * Find the rendered control for a path, walking up dotted segments until a container exists, then
 * unfold every closed `<details>` above it. Returns undefined when nothing is mounted yet, which lets
 * the caller clear a filter and retry instead of dropping the focus request.
 */
export function focusRenderedControl(documentLike: FocusDocument, path: string): FocusableNode | undefined {
  let key = path;
  let target = documentLike.getElementById(fieldId(key)) || documentLike.getElementById(key);
  while (!target && key.includes('.')) {
    key = key.slice(0, key.lastIndexOf('.'));
    target = documentLike.getElementById(fieldId(key)) || documentLike.getElementById(key);
  }
  if (!target) return undefined;
  let node: FocusableNode | null = target;
  while (node) {
    const wrapper = node.closest('details');
    if (!wrapper) break;
    wrapper.open = true;
    node = wrapper.parentElement;
  }
  target.scrollIntoView?.({ block: 'center' });
  target.focus?.();
  return target;
}

/** The route kind at an indexed route path, so a label follows the record through a reorder. */
export function routeKindForPath(routes: ReadonlyArray<{ kind: string }>, path: string): string | undefined {
  const match = /^pageFetch\.routes\.(\d+)/.exec(path);
  return match ? routes[Number(match[1])]?.kind : undefined;
}

/** An issue's own action target wins over its value path. */
export function focusForIssue(issue: Pick<ConfigIssue, 'path' | 'action'>): { tab: SettingsTab; target: string } {
  return focusForPath(issue.action?.target || issue.path);
}

/**
 * The causes the save gate will refuse, said before saving. Only enabled dependencies count, so a
 * browser-dependent setup can be configured and switched off while the browser is offline.
 */
export function browserGateIssues(draft: SearchConfig): ConfigIssue[] {
  const browserBackends = Object.entries(draft.backends).filter(([, row]) => row.enabled && row.mode === 'browser');
  const fetchIndex = draft.pageFetch.routes.findIndex(route => route.kind === 'browser');
  const fetchEnabled = fetchIndex >= 0 && Boolean(draft.pageFetch.routes[fetchIndex]?.enabled);
  if (!browserBackends.length && !fetchEnabled) return [];
  const shared = draft.browser.endpoint.trim();
  const issues: ConfigIssue[] = [];
  if (fetchEnabled && !shared) {
    issues.push({
      path: `pageFetch.routes.${fetchIndex}.enabled`,
      message: 'The browser route needs a shared browser endpoint before it can be enabled.',
      code: 'pageFetch.route.browserEndpointMissing',
      params: { kind: 'browser' },
      action: { target: 'browser.endpoint' },
    });
  }
  for (const [id, row] of browserBackends) {
    if (shared || row.endpoint) continue;
    issues.push({
      path: `backends.${id}.enabled`,
      message: 'An enabled browser-dependent feature has no endpoint to attach to.',
      code: 'browser.endpoint.missing',
      params: { backend: id },
      action: { target: 'browser.endpoint' },
    });
  }
  if (shared && !parseBrowserEndpoint(shared)) {
    issues.push({ path: 'browser.endpoint', message: 'The shared browser endpoint is not a WS(S) Playwright endpoint.', code: 'browser.endpoint.invalid', action: { target: 'browser.endpoint' } });
  }
  return issues;
}
