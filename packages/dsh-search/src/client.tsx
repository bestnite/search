import styles from './client.css';
import overrides from './client.overrides.css';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import {
  catalog, CLOUDFLARE_CHALLENGE_PRESET, DEFAULT_FALLBACK_RULES, FETCH_BOUNDS, FETCH_CONDITION_FIELDS, FETCH_CONDITION_TYPES,
  FETCH_FAILURE_KINDS, FETCH_MATCH_OPERATORS, LANGUAGES, MAX_CONCURRENT_READS, MIN_MAX_CONCURRENT_READS, REGIONS,
  STATUS_ERROR_PRESET, defaultConfig, fetchReadiness, fetchReadinessProviders, parseBrowserEndpoint, validateConfig,
} from '@nite07/search-core/static';
import type {
  AccessMode, BackendDefinition, ConfigIssue, FetchConditionField, FetchFallbackCondition, FetchFallbackRule, FetchMatchOperator,
  FetchRouteConfig, SearchConfig,
} from '@nite07/search-core/static';
import type { BackendOutcome } from '@nite07/search-core';
import { browserGateIssues, classifySaveOutcome, fieldId, focusForIssue, focusForPath, focusRenderedControl, readbackMatches, routeKindForPath, sameDraft, shouldResetBackendFilter } from './presenter';
import type { SaveReadback, SaveResponse } from './presenter';
import { feedbackAutoDismissMs, feedbackForSave, feedbackTakesFocus } from './feedback';
import type { SaveFeedback } from './feedback';
import { decideOverlayKey } from './overlay-keys';
import { blockersOf, visible } from './visibility';
import type { FetchProviderInfo, SettingsSnapshot } from './types';

const API = '/api/nite-search';
/** What Tab can reach inside the feedback card, so the trap cycles over real controls only. */
const FEEDBACK_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** The served configuration and the draft are the same configuration when their values agree. */
const same = (a: unknown, b: unknown) => sameDraft(a as SearchConfig, b as SearchConfig);
const ranges: Record<string, [number, number]> = { maxResults: [1, 50], concurrency: [1, 20], overallTimeoutMs: [1000, 180000], 'retry.maxRetries': [0, 5], 'retry.initialDelayMs': [0, 60000], 'retry.maxDelayMs': [0, 120000], 'cache.ttlSeconds': [1, 86400], 'cache.maxEntries': [1, 1000], 'breaker.threshold': [1, 100], 'breaker.cooldownMs': [1000, 3600000], 'diagnostics.maxEntries': [1, 500], 'backend.timeoutMs': [1000, 120000], 'backend.rateLimitPerMinute': [0, 100000], 'backend.dailyAttemptLimit': [0, 1000000], 'browser.maxConcurrentReads': [MIN_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS] };
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];
function get(value: any, path: string): any { return path.split('.').reduce((v, k) => v?.[k], value); }
function set(value: SearchConfig, path: string, next: unknown): SearchConfig {
  const result = clone(value); const keys = path.split('.'); const last = keys.pop()!;
  let target: any = result; for (const key of keys) target = target[key]; target[last] = next; return result;
}
function redact(config: SearchConfig): SearchConfig {
  const output = clone(config);
  for (const backend of Object.values(output.backends)) {
    try { const url = new URL(backend.endpoint); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; backend.endpoint = url.toString(); } catch { backend.endpoint = ''; }
    for (const key of Object.keys(backend.options)) if (/key|token|secret|password|auth/i.test(key)) backend.options[key] = '';
  }
  return output;
}

/** One request failure with the HTTP status and structured body kept, so save states stay distinct. */
class RequestError extends Error {
  constructor(readonly status: number, readonly payload: any) {
    super(payload?.error?.message || `HTTP ${status}`);
    this.name = 'RequestError';
  }
}

async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  let payload: any;
  try { payload = await response.json(); } catch { payload = undefined; }
  if (!response.ok) throw new RequestError(response.status, payload);
  return payload;
}

/**
 * The build wraps this module once in the DSH lazy module factory, which hands over the host's React
 * and ReactDOM. ReactDOM renders the save feedback into a fixed layer on `document.body`: the settings
 * surface lives inside a fixed modal (z-index 1000), so a message rendered inside the page is both
 * below the modal's own scroll container and clipped by it.
 */
export function createClient(React: any, ReactDOM?: any) {
  function ListInput({ value, onCommit, numeric, ...props }: any) {
    const formatted = value.join(', ');
    const [text, setText] = React.useState(formatted);
    React.useEffect(() => setText(formatted), [formatted]);
    return <input {...props} type="text" value={text} onChange={(event: any) => setText(event.target.value)} onBlur={() => onCommit(text.trim() ? text.split(',').map((part: string) => numeric ? Number(part.trim()) : part.trim()).filter((part: any) => numeric || part) : [])} />;
  }
  return {
    inject: ['slots', 'locale'],
    apply(ctx: any) {
      const { meta: _enMeta, ...enUi } = en;
      const { meta: _zhMeta, ...zhUi } = zh;
      ctx.effect(() => ctx.locale.register('nite.search', 'en', enUi));
      ctx.effect(() => ctx.locale.register('nite.search', 'zh', zhUi));
      const t = ctx.locale.bind('nite.search');
      const tr = (key: string, vars: Record<string, string | number>) => String(t(key)).replace(/\{\{(\w+)\}\}/g, (_m: string, name: string) => String(vars[name] ?? ''));
      const known = (key: string): boolean => String(t(key)) !== key;
      function Page() {
        const locale = React.useSyncExternalStore((fn: () => void) => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot());
        const lang = locale.active.startsWith('zh') ? 'zh' : 'en';
        const [snapshot, setSnapshot] = React.useState(null as SettingsSnapshot | null);
        const [draft, setDraft] = React.useState(defaultConfig() as SearchConfig);
        const [issues, setIssues] = React.useState([] as ConfigIssue[]);
        const [pending, setPending] = React.useState('');
        const [notice, setNotice] = React.useState('');
        const [failed, setFailed] = React.useState(false);
        const [secrets, setSecrets] = React.useState({} as Record<string, string>);
        const [query, setQuery] = React.useState('');
        const [testBackend, setTestBackend] = React.useState('');
        const [testResult, setTestResult] = React.useState(null as any);
        const [importText, setImportText] = React.useState('');
        const [showTransfer, setShowTransfer] = React.useState(false);
        const [backendQuery, setBackendQuery] = React.useState('');
        const [fetchTestUrl, setFetchTestUrl] = React.useState('');
        const [fetchTestFormat, setFetchTestFormat] = React.useState('markdown');
        const [fetchTestResult, setFetchTestResult] = React.useState(null as any);
        const [backendFilter, setBackendFilter] = React.useState('all');
        const [confirming, setConfirming] = React.useState(null as { kind: string; backendId?: string } | null);
        const [tab, setTab] = React.useState('behavior');
        const [pendingFocus, setPendingFocus] = React.useState(null as { path: string; nonce: number } | null);
        const [verification, setVerification] = React.useState(null as { endpoint: string; tokenEpoch: number; source: 'manual' | 'save'; ok: boolean; code?: string; durationMs: number; at: number } | null);
        const [tokenEpoch, setTokenEpoch] = React.useState(0);
        const [feedback, setFeedback] = React.useState(null as SaveFeedback | null);
        const summary = React.useRef(null as HTMLDivElement | null);
        const feedbackCard = React.useRef(null as HTMLDivElement | null);
        const saveButton = React.useRef(null as HTMLButtonElement | null);
        const feedbackTimer = React.useRef(null as ReturnType<typeof setTimeout> | null);
        const clearFeedbackTimer = () => { if (feedbackTimer.current) { clearTimeout(feedbackTimer.current); feedbackTimer.current = null; } };
        /** A success message is transient and never takes focus; an error stays until the user closes it. */
        function showFeedback(card: SaveFeedback) {
          clearFeedbackTimer();
          setFeedback(card);
          const dismissAfter = feedbackAutoDismissMs(card);
          if (dismissAfter === undefined) return;
          feedbackTimer.current = setTimeout(() => { feedbackTimer.current = null; setFeedback(null); }, dismissAfter);
        }
        /**
         * Close the card. Focus returns to the save button only when the card was holding it, so an
         * error the user dismissed with Escape does not drop the keyboard at the top of the document;
         * a success that dismisses itself never moves focus at all.
         */
        function dismissFeedback() {
          const held = typeof document !== 'undefined' && !!feedbackCard.current && feedbackCard.current.contains(document.activeElement);
          clearFeedbackTimer();
          setFeedback(null);
          if (held) saveButton.current?.focus();
        }
        /** The card is outside the modal's focus trap, so it keeps `Escape` and `Tab` for itself. */
        function feedbackKeyDown(event: any) {
          const card = feedbackCard.current;
          if (!card) return;
          const decision = decideOverlayKey(
            { key: String(event.key), shiftKey: Boolean(event.shiftKey) },
            {
              active: typeof document === 'undefined' ? undefined : document.activeElement,
              focusables: Array.from(card.querySelectorAll(FEEDBACK_FOCUSABLE)) as unknown[],
              card,
            },
          );
          if (!decision) return;
          if (decision.preventDefault) event.preventDefault();
          if (decision.stopPropagation) event.stopPropagation();
          if (decision.dismiss) { dismissFeedback(); return; }
          (decision.focus as HTMLElement | undefined)?.focus?.();
        }
        React.useEffect(() => () => clearFeedbackTimer(), []);
        // An error card takes focus so a screen reader announces it; a success toast never does, so a
        // save that just succeeded cannot pull the keyboard away from the next edit. `Escape` and
        // `Tab` are handled on the card itself (see `feedbackKeyDown`), never on `document`: a document
        // listener here would race the host modal's own handler and close the whole settings panel.
        React.useEffect(() => {
          if (!feedback || !feedbackTakesFocus(feedback)) return;
          feedbackCard.current?.focus();
        }, [feedback]);
        const dirty = !!snapshot && !same(draft, snapshot.config);
        const definitions: BackendDefinition[] = snapshot?.catalog || catalog;
        const enabledSaved = definitions.filter(def => def.status === 'documented' && snapshot?.config.backends[def.id]?.enabled);
        React.useEffect(() => { let live = true; request('settings').then((value: SettingsSnapshot) => { if (live) { setSnapshot(value); setDraft(clone(value.config)); } }).catch(() => { if (live) { setNotice('loadFailed'); setFailed(true); } }); return () => { live = false; }; }, []);
        React.useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
        const fetchRoutesPath = 'pageFetch.routes';
        function update(path: string, value: unknown) {
          setDraft((previous: SearchConfig) => {
            let next = set(previous, path, value);
            const match = /^backends\.([^.]+)\.mode$/.exec(path);
            if (match) {
              const definition = definitions.find(def => def.id === match[1]);
              const endpoint = definition?.modes.find(mode => mode.mode === value)?.endpoint;
              if (endpoint) next = set(next, `backends.${match[1]}.endpoint`, endpoint);
            }
            // A fetch access mode declares its own endpoint, so switching the mode adopts that
            // endpoint instead of keeping the previous mode's one (an MCP URL would never serve a
            // keyed REST mode). A typed custom endpoint is the user's to keep, so only the declared
            // endpoints are replaced, never an arbitrary URL.
            const fetchMode = /^backends\.([^.]+)\.fetch\.mode$/.exec(path);
            if (fetchMode) {
              const definition = definitions.find(def => def.id === fetchMode[1]);
              const current = get(next, `backends.${fetchMode[1]}.fetch.endpoint`);
              const declared = definition?.modes.map(mode => mode.fetchEndpoint).filter((item): item is string => !!item) ?? [];
              const endpoint = definition?.modes.find(mode => mode.mode === value)?.fetchEndpoint;
              if (endpoint && (!current || declared.includes(String(current)))) next = set(next, `backends.${fetchMode[1]}.fetch.endpoint`, endpoint);
            }
            return next;
          });
          setNotice('');
        }
        /** The label of an editable control, independent of any validation issue. */
        function label(path: string) {
          const option = /^backends\.[^.]+\.options\.(.+)$/.exec(path);
          if (option) return definitions.find(def => def.id === /^backends\.([^.]+)\./.exec(path)?.[1])?.options.find(field => field.key === option[1])?.label[lang] || t('invalidField');
          return t(`field.${path.replace(/^backends\.[^.]+\./, 'backend.')}`);
        }
        const titleOf = (id: string | number | undefined): string => definitions.find(def => def.id === String(id))?.title || String(id ?? '');
        /** Localize one issue from its stable code; the server's English sentence is the fallback. */
        function issueText(issue: ConfigIssue): string {
          if (!issue.code) return issue.message;
          const params: Record<string, string | number> = { ...(issue.params || {}) };
          if (typeof params.kind === 'string') params.kindLabel = t(`fetchRoute.${params.kind}`);
          if (typeof params.provider === 'string') params.providerLabel = titleOf(params.provider);
          if (typeof params.backend === 'string') params.backendLabel = titleOf(params.backend);
          if (typeof params.route === 'string') params.routeLabel = t(`fetchRoute.${params.route}`);
          const key = `issue.${issue.code}`;
          return known(key) ? tr(key, params) : issue.message;
        }
        /** A readable name for the field an issue points at, including route kind and provider. */
        function pathLabel(path: string): string {
          const route = /^pageFetch\.routes\.(\d+)(?:\.(.+))?$/.exec(path);
          if (route) {
            const kind = routeKindForPath(draft.pageFetch.routes, path);
            const kindLabel = kind ? t(`fetchRoute.${kind}`) : t('notSpecified');
            const tail = route[2] || '';
            if (!tail) return tr('issuePath.route', { kind: kindLabel });
            if (tail === 'enabled') return tr('issuePath.routeField', { kind: kindLabel, field: t('fetchEnabled') });
            if (tail === 'timeoutMs') return tr('issuePath.routeField', { kind: kindLabel, field: t('fetchTimeout') });
            if (tail.startsWith('rules')) return tr('issuePath.routeField', { kind: kindLabel, field: t('fetchRules') });
            return tr('issuePath.routeField', { kind: kindLabel, field: t('invalidField') });
          }
          const fetchField = /^backends\.([^.]+)\.fetch\.(.+)$/.exec(path);
          if (fetchField) {
            const fieldKey = fetchField[2] === 'mode' ? 'fetchMode' : fetchField[2] === 'endpoint' ? 'fetchEndpoint' : fetchField[2] === 'timeoutMs' ? 'fetchTimeout' : 'advancedOptions';
            return tr('issuePath.backendField', { backend: titleOf(fetchField[1]), field: t(fieldKey) });
          }
          const backendField = /^backends\.([^.]+)\.(.+)$/.exec(path);
          if (backendField) {
            const fieldKey = `field.backend.${backendField[2]}`;
            const fieldLabel = known(fieldKey) ? t(fieldKey) : t(`field.${path.replace(/^backends\.[^.]+\./, 'backend.')}`);
            return tr('issuePath.backendField', { backend: titleOf(backendField[1]), field: fieldLabel });
          }
          const fieldKey = `field.${path}`;
          return known(fieldKey) ? t(fieldKey) : t('invalidField');
        }
        /** Reveal the tab that owns a path, then its section, details and the actual control. */
        function focusPath(path: string) {
          const destination = focusForPath(path);
          setTab(destination.tab);
          setPendingFocus((previous: { path: string; nonce: number } | null) => ({ path: destination.target, nonce: (previous?.nonce || 0) + 1 }));
        }
        function focusIssue(issue: ConfigIssue) {
          const destination = focusForIssue(issue);
          setTab(destination.tab);
          setPendingFocus((previous: { path: string; nonce: number } | null) => ({ path: destination.target, nonce: (previous?.nonce || 0) + 1 }));
        }
        React.useEffect(() => {
          if (!pendingFocus) return;
          const target = focusRenderedControl(document as unknown as Parameters<typeof focusRenderedControl>[0], pendingFocus.path);
          if (!target) {
            // A backend filter can hide the card that owns the issue. Clear it and let the effect run
            // again after the rerender instead of dropping the focus request.
            if (shouldResetBackendFilter(pendingFocus.path, backendQuery, backendFilter)) {
              setBackendQuery('');
              setBackendFilter('all');
              return;
            }
          }
          setPendingFocus(null);
        }, [pendingFocus, tab, backendQuery, backendFilter]);
        // The summary takes focus when a new list of issues arrives, unless the floating card is the
        // thing announcing them. It must not take focus back when the card is dismissed: that click is
        // usually a field link, and the field it just moved to has to keep the focus.
        const feedbackKind = React.useRef('');
        React.useEffect(() => { feedbackKind.current = feedback?.kind ?? ''; }, [feedback]);
        React.useEffect(() => { if (issues.length && feedbackKind.current !== 'error') summary.current?.focus(); }, [issues]);
        React.useEffect(() => {
          if (!enabledSaved.length) { if (testBackend) setTestBackend(''); return; }
          if (!enabledSaved.some(def => def.id === testBackend)) setTestBackend(enabledSaved[0]!.id);
        }, [snapshot]);
        function field(path: string, options: { type?: string; choices?: string[]; help?: string; customLabel?: string; disabled?: boolean; min?: number; max?: number } = {}) {
          const { type = 'text', choices, help, customLabel, disabled = false } = options;
          const value = get(draft, path); const id = fieldId(path); const errors = issues.filter((issue: ConfigIssue) => issue.path === path);
          const range = ranges[path.replace(/^backends\.[^.]+\./, 'backend.')];
          const min = options.min ?? range?.[0]; const max = options.max ?? range?.[1];
          const props = { id, disabled: !!pending || disabled, 'aria-invalid': errors.length > 0, 'aria-describedby': `${id}-help${errors.length ? ` ${id}-error` : ''}` };
          return <div className={`ns-field ${type === 'checkbox' ? 'ns-check' : ''}`} key={path}>
            <label className="ns-label" htmlFor={id}>{customLabel || label(path)}</label>
            {type === 'checkbox' ? <input {...props} type="checkbox" checked={!!value} onChange={(event: any) => update(path, event.target.checked)} /> : choices ? <select {...props} value={value} onChange={(event: any) => update(path, event.target.value)}>{choices.map(choice => <option key={choice} value={choice}>{path === 'language' || path === 'region' ? (choice === '' ? t('notSpecified') : choice) : path === 'pageFetch.browser.context' ? t(`browserContext.${choice}`) : path.includes('.options.') || path.includes('.fetch.options.') ? choice : t(`choice.${choice}`)}</option>)}</select> : type === 'list' || type === 'numbers' ? <ListInput {...props} value={value} numeric={type === 'numbers'} onCommit={(next: unknown) => update(path, next)} /> : <input {...props} type={type} min={min} max={max} value={value ?? ''} onChange={(event: any) => { const raw = event.target.value; update(path, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw); }} />}
            <small className="ns-help" id={`${id}-help`}>{help || t(`help.${path.replace(/^backends\.[^.]+\./, 'backend.')}`)}{type === 'number' && min !== undefined && max !== undefined ? ` (${min}–${max})` : ''}</small>
            {!!errors.length && <small className="ns-error" id={`${id}-error`}>{issueText(errors[0]!)}<button type="button" className="ns-link" onClick={() => focusIssue(errors[0]!)}>{t('showField')}</button></small>}
          </div>;
        }
        /** Renders a field group in the declared order, dropping members hidden by their owning switch. */
        function fields(paths: string[], options: Record<string, any> = {}) {
          return paths.filter(path => visible(path, draft)).map(path => field(path, options[path] || {}));
        }
        function section(title: string, ids: string[], paths: string[], options: Record<string, any> = {}) {
          const shown = fields(paths, options);
          return shown.length ? <section className="ns-card" aria-labelledby={ids[0]}><h3 id={ids[0]} className="ns-section-title">{t(title)}</h3><div className="ns-grid">{shown}</div></section> : null;
        }
        async function refresh() { const next = await request('settings') as SettingsSnapshot; setSnapshot(next); return next; }

        // Fetch readiness is derived from the draft, not from the last saved snapshot: moving a switch
        // must answer "would this work if I saved now" without a save round-trip.
        const draftFetchRows = snapshot ? fetchReadinessProviders(draft, definitions, id => !!snapshot.credentials[id]?.configured) : [];
        const fetchProviders: FetchProviderInfo[] = draftFetchRows.map(row => {
          const definition = definitions.find(item => item.id === row.id);
          return {
            ...row,
            options: definition?.fetch?.options || [],
            docs: definition?.fetch?.docs || '',
            verifiedAt: definition?.fetch?.verifiedAt || '',
            ...(definition?.fetch?.notes ? { notes: definition.fetch.notes } : {}),
          };
        });
        const fetchProblems = snapshot ? fetchReadiness(draft, draftFetchRows) : [];
        const fetchReady = fetchProblems.length === 0;
        const selectedFetchProvider: FetchProviderInfo | undefined = fetchProviders.find((provider: FetchProviderInfo) => provider.id === draft.pageFetch.providerId);
        const browserRouteIndex = draft.pageFetch.routes.findIndex((route: FetchRouteConfig) => route.kind === 'browser');
        const browserRoute = browserRouteIndex >= 0 ? draft.pageFetch.routes[browserRouteIndex]! : undefined;
        const browserSearchDependents = definitions.filter(def => draft.backends[def.id]?.enabled && draft.backends[def.id]?.mode === 'browser');
        const browserEndpointFor = (id: string): { endpoint: string; source: 'shared' | 'own' | 'missing' } => {
          if (draft.browser.endpoint) return { endpoint: draft.browser.endpoint, source: 'shared' };
          const own = draft.backends[id]?.endpoint;
          return own ? { endpoint: own, source: 'own' } : { endpoint: '', source: 'missing' };
        };
        const browserDependents = [
          ...browserSearchDependents.map(def => {
            const effective = browserEndpointFor(def.id);
            return { key: `backend-${def.id}`, kind: 'search' as const, title: def.title, endpoint: effective.endpoint, source: effective.source, jump: `backends.${def.id}.mode`, fix: effective.endpoint ? undefined : 'browser.endpoint' };
          }),
          ...(browserRoute?.enabled ? [{
            key: 'fetch-browser', kind: 'fetch' as const, title: t('fetchRoute.browser'), endpoint: draft.browser.endpoint, source: draft.browser.endpoint ? 'shared' as const : 'missing' as const,
            jump: `${fetchRoutesPath}.${browserRouteIndex}.enabled`, fix: draft.browser.endpoint ? undefined : 'browser.endpoint',
          }] : []),
        ];
        async function save() {
          const merged = [...validateConfig(draft), ...browserGateIssues(draft)];
          const errors = merged.filter((issue, index) => merged.findIndex(other => other.path === issue.path && other.code === issue.code) === index);
          setIssues(errors); if (errors.length || !snapshot) return;
          const intended = clone(draft); const revision = snapshot.revision;
          // The floating pending card is the single "saving" indicator; the footer keeps showing the
          // draft state, so the phrase is not repeated in two places.
          setPending('save'); setNotice(''); setFailed(false); dismissFeedback();
          let response: SaveResponse | undefined;
          let transportError = false;
          try {
            // Never replay a mutation: a restart may terminate the response after a commit.
            const result = await request('settings', { config: intended, expectedRevision: revision });
            response = { status: 200, payload: result };
          } catch (error) {
            if (error instanceof RequestError) response = { status: error.status, payload: error.payload };
            else transportError = true;
          }
          // A definite rejection (400) happened before the write and needs no read-back. Everything
          // else, including a 5xx or a lost response, is classified only after reading the saved state.
          let next: SettingsSnapshot | undefined;
          let readback: SaveReadback | undefined;
          if (!response || response.status === 200 || response.status === 409 || response.status >= 500) {
            try {
              next = await refresh();
              // The server names the revision it wrote; a read-back that reports it is the written
              // configuration, and a read-back that cannot be represented stays unknown.
              const writtenRevision = typeof response?.payload?.revision === 'string' ? String(response.payload.revision) : undefined;
              readback = { ok: true, matches: readbackMatches({ saved: next.config, intended, savedRevision: next.revision, ...(writtenRevision ? { writtenRevision } : {}) }) };
            } catch { readback = { ok: false }; }
          }
          const outcome = classifySaveOutcome({
            ...(response ? { response } : {}),
            ...(transportError ? { transportError: true } : {}),
            ...(readback ? { readback } : {}),
          });
          const verified = Boolean(response?.payload?.verified);
          switch (outcome.kind) {
            case 'saved': {
              // Adopting the served configuration is what keeps a following save from claiming a
              // difference that only comes from the write's normalization.
              if (next) setDraft(clone(next.config));
              setIssues([]); setNotice('');
              if (verified) setVerification({ endpoint: intended.browser.endpoint.trim(), tokenEpoch, source: 'save', ok: true, durationMs: 0, at: Date.now() });
              break;
            }
            case 'rejected': setFailed(true); setIssues(outcome.issues); setNotice(''); break;
            case 'conflict':
            case 'write-failed':
            case 'unconfirmed':
            case 'state-unknown': setFailed(true); setNotice(''); break;
          }
          // One card explains the result, and it is the same one in both languages: the reason, the
          // field links, and nothing asserted beyond what the outcome proved.
          const serverMessage = typeof response?.payload?.error?.message === 'string' ? String(response.payload.error.message) : '';
          const card = feedbackForSave(outcome, { known, t, tr }, { ...(verified ? { verified } : {}), ...(serverMessage ? { serverMessage } : {}) });
          if (card) showFeedback(card); else dismissFeedback();
          setPending('');
        }
        async function action(actionName: string, extra: Record<string, unknown> = {}) {
          setPending(actionName); setFailed(false); setNotice('working');
          try { const result = await request('action', { action: actionName, ...extra }); if (actionName === 'test') setTestResult(result); if (actionName === 'fetch-test') setFetchTestResult(result); await refresh(); setNotice('done'); }
          catch { setFailed(true); setNotice('actionFailed'); } finally { setPending(''); }
        }
        async function credential(id: string, remove: boolean) {
          if (!snapshot) return;
          setPending(`credential-${id}`); setFailed(false); setNotice('working');
          try { await request('credential', { backendId: id, ...(remove ? { remove: true } : { value: secrets[id] }) }); setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); await refresh(); setNotice('credentialSaved'); }
          catch { setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); setFailed(true); setNotice('credentialFailed'); } finally { setPending(''); }
        }
        /** The endpoint token guards the browser, so it is stored once here rather than per backend. */
        async function browserCredential(remove: boolean) {
          if (!snapshot) return;
          setPending('credential-browser'); setFailed(false); setNotice('working');
          try { await request('credential', { scope: 'browser', ...(remove ? { remove: true } : { value: secrets.browser }) }); setSecrets((previous: Record<string, string>) => ({ ...previous, browser: '' })); setTokenEpoch((previous: number) => previous + 1); await refresh(); setNotice('credentialSaved'); }
          catch { setSecrets((previous: Record<string, string>) => ({ ...previous, browser: '' })); setFailed(true); setNotice('credentialFailed'); } finally { setPending(''); }
        }
        /** A manual check of the draft endpoint. Nothing runs on render, and no token is ever sent. */
        async function verifyConnection() {
          const endpoint = draft.browser.endpoint.trim();
          if (!endpoint || !snapshot) return;
          setPending('verify-browser'); setFailed(false); setNotice('working');
          try {
            const result = await request('action', { action: 'verify-browser', endpoint });
            setVerification({ endpoint, tokenEpoch, source: 'manual', ok: Boolean(result.ok), ...(result.code ? { code: result.code } : {}), durationMs: Number(result.durationMs) || 0, at: Date.now() });
            if (result.ok) { setNotice('connectionVerified'); } else { setFailed(true); setNotice('connectionFailed'); }
          } catch { setFailed(true); setNotice('connectionCheckFailed'); } finally { setPending(''); }
        }
        function importConfig() {
          try { const parsed = JSON.parse(importText); const errors = validateConfig(parsed); setIssues(errors); if (errors.length) return; setDraft(clone(parsed)); setImportText(''); setNotice('imported'); setFailed(false); }
          catch { setNotice('importFailed'); setFailed(true); }
        }
        function exportConfig() {
          const blob = new Blob([JSON.stringify(redact(draft), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'nite-search.redacted.json'; link.click(); URL.revokeObjectURL(url);
        }

        /** Rule and route editors for the Fetch tab. They edit the one shared draft, never the file. */
        function parseStatusList(value: string): number[] {
          return value.split(',').map(part => Number(part.trim())).filter(part => Number.isInteger(part));
        }
        function defaultCondition(type: string): FetchFallbackCondition {
          if (type === 'status' || type === 'api-status') return { type, statuses: [404] };
          if (type === 'error') return { type: 'error', kinds: ['protocol'] };
          if (type === 'match') return { type: 'match', field: 'text', operator: 'contains', value: '', caseSensitive: false };
          return { type: type === 'timeout' ? 'timeout' : 'network' };
        }
        function conditionEditor(routeIndex: number, ruleIndex: number, conditionIndex: number, condition: FetchFallbackCondition, routeKind: string, replaceRule: (at: number, change: (rule: FetchFallbackRule) => FetchFallbackRule) => void) {
          const conditionPath = `${fetchRoutesPath}.${routeIndex}.rules.${ruleIndex}.conditions.${conditionIndex}`;
          const patch = (next: FetchFallbackCondition) => replaceRule(ruleIndex, item => ({ ...item, conditions: item.conditions.map((entry, at) => at === conditionIndex ? next : entry) }));
          const remove = () => replaceRule(ruleIndex, item => ({ ...item, conditions: item.conditions.filter((_entry, at) => at !== conditionIndex) }));
          const types = (FETCH_CONDITION_TYPES as readonly string[]).filter(type => type !== 'api-status' || routeKind === 'provider');
          return <div className="ns-condition" id={fieldId(conditionPath)} tabIndex={-1} key={conditionIndex}>
            <select aria-label={t('fetchConditionType')} id={fieldId(`${conditionPath}.type`)} value={condition.type} disabled={!!pending} onChange={(event: any) => patch(defaultCondition(event.target.value))}>
              {types.map(type => <option key={type} value={type}>{t(`condition.${type}`)}</option>)}
            </select>
            {(condition.type === 'status' || condition.type === 'api-status') && <input aria-label={t('fetchConditionStatuses')} id={fieldId(`${conditionPath}.statuses`)} value={condition.statuses.join(', ')} placeholder="404, 500" disabled={!!pending} onChange={(event: any) => patch({ type: condition.type as 'status' | 'api-status', statuses: parseStatusList(event.target.value) })} />}
            {condition.type === 'error' && <span className="ns-actions">{FETCH_FAILURE_KINDS.map(kind => <label key={kind} className="ns-check"><input type="checkbox" checked={condition.kinds.includes(kind)} disabled={!!pending} onChange={(event: any) => patch({ type: 'error', kinds: event.target.checked ? [...condition.kinds, kind] : condition.kinds.filter(item => item !== kind) })} />{t(`failure.${kind}`)}</label>)}</span>}
            {condition.type === 'match' && <>
              <select aria-label={t('fetchConditionField')} id={fieldId(`${conditionPath}.field`)} value={condition.field} disabled={!!pending} onChange={(event: any) => patch({ ...condition, field: event.target.value as FetchConditionField })}>
                {(FETCH_CONDITION_FIELDS as readonly string[]).map(name => <option key={name} value={name}>{t(`matchField.${name}`)}</option>)}
              </select>
              <select aria-label={t('fetchConditionOperator')} id={fieldId(`${conditionPath}.operator`)} value={condition.operator} disabled={!!pending} onChange={(event: any) => patch({ ...condition, operator: event.target.value as FetchMatchOperator })}>
                {(FETCH_MATCH_OPERATORS as readonly string[]).map(operator => <option key={operator} value={operator}>{t(`matchOperator.${operator}`)}</option>)}
              </select>
              <input aria-label={t('fetchConditionValue')} id={fieldId(`${conditionPath}.value`)} value={condition.value} disabled={!!pending} onChange={(event: any) => patch({ ...condition, value: event.target.value })} />
              <label className="ns-check"><input type="checkbox" checked={condition.caseSensitive} disabled={!!pending} onChange={(event: any) => patch({ ...condition, caseSensitive: event.target.checked })} />{t('fetchConditionCase')}</label>
            </>}
            <button type="button" className="ns-link" disabled={!!pending} onClick={remove}>{t('fetchRemoveCondition')}</button>
          </div>;
        }
        function ruleEditor(routeIndex: number, route: FetchRouteConfig) {
          const rules = route.rules ?? [];
          const rulesPath = `${fetchRoutesPath}.${routeIndex}.rules`;
          const write = (next: FetchFallbackRule[]) => update(rulesPath, next);
          const replaceRule = (at: number, change: (rule: FetchFallbackRule) => FetchFallbackRule) => write(rules.map((item, index) => (index === at ? change(clone(item)) : item)));
          const nextId = (base: string) => {
            let candidate = base; let counter = 2;
            while (rules.some(item => item.id === candidate)) { candidate = `${base}-${counter}`; counter += 1; }
            return candidate;
          };
          const canAdd = rules.length < FETCH_BOUNDS.rulesPerRoute;
          return <details className="ns-advanced" id={fieldId(rulesPath)}>
            <summary>{t('fetchRules')} <span className="ns-muted">{tr('fetchRulesCount', { count: rules.length, max: FETCH_BOUNDS.rulesPerRoute })}</span></summary>
            <p className="ns-muted">{t('fetchRulesHelp')}</p>
            {rules.map((rule, ruleIndex) => {
              const rulePath = `${rulesPath}.${ruleIndex}`;
              return <div className="ns-rule" id={fieldId(rulePath)} tabIndex={-1} key={`${route.kind}-${rule.id}-${ruleIndex}`}>
                <div className="ns-rule-head">
                  <label className="ns-check"><input type="checkbox" checked={rule.enabled} disabled={!!pending} onChange={(event: any) => replaceRule(ruleIndex, item => ({ ...item, enabled: event.target.checked }))} /><code>{rule.id}</code></label>
                  <button type="button" className="ns-link" disabled={!!pending} onClick={() => write(rules.filter((_item, at) => at !== ruleIndex))}>{t('fetchRemoveRule')}</button>
                </div>
                {rule.conditions.map((condition, conditionIndex) => conditionEditor(routeIndex, ruleIndex, conditionIndex, condition, route.kind, replaceRule))}
                <button type="button" className="ns-link" id={fieldId(`${rulePath}.conditions`)} disabled={!!pending || rule.conditions.length >= FETCH_BOUNDS.conditionsPerRule} onClick={() => replaceRule(ruleIndex, item => ({ ...item, conditions: [...item.conditions, { type: 'network' }] }))}>{t('fetchAddCondition')}</button>
              </div>;
            })}
            <div className="ns-actions">
              <button type="button" disabled={!!pending || !canAdd} onClick={() => write([...rules, { id: nextId('custom'), enabled: true, conditions: [{ type: 'network' }] }])}>{t('fetchAddRule')}</button>
              <button type="button" disabled={!!pending || !canAdd} onClick={() => write([...rules, { ...clone(STATUS_ERROR_PRESET), id: nextId('status-errors') }])}>{t('fetchAddStatusPreset')}</button>
              <button type="button" disabled={!!pending || !canAdd} onClick={() => write([...rules, { ...clone(CLOUDFLARE_CHALLENGE_PRESET), id: nextId('cloudflare-challenge') }])}>{t('fetchAddCloudflarePreset')}</button>
              <button type="button" disabled={!!pending} onClick={() => write(DEFAULT_FALLBACK_RULES.map(item => clone(item)))}>{t('fetchRestoreDefaultRules')}</button>
            </div>
            <p className="ns-muted">{t('fetchPresetsHelp')}</p>
          </details>;
        }
        function fetchRouteStatus(route: FetchRouteConfig, index: number) {
          if (route.kind === 'browser') {
            return <p className="ns-muted ns-dependency">
              {draft.browser.endpoint ? tr('routeBrowserEndpoint', { endpoint: draft.browser.endpoint }) : <>{t('routeBrowserEndpointMissing')} <button type="button" className="ns-link" onClick={() => focusPath('browser.endpoint')}>{t('fixIt')}</button></>}
            </p>;
          }
          if (route.kind === 'provider') {
            return <p className="ns-muted ns-dependency">{selectedFetchProvider ? tr('routeProviderSelected', { provider: selectedFetchProvider.title, mode: draft.backends[selectedFetchProvider.id]?.fetch.mode || '' }) : <>{t('routeProviderMissing')} <button type="button" className="ns-link" onClick={() => focusPath('pageFetch.providerId')}>{t('fixIt')}</button></>}
            </p>;
          }
          return null;
        }
        function fetchRouteRows() {
          const routes: FetchRouteConfig[] = draft.pageFetch?.routes ?? [];
          const move = (index: number, delta: number) => {
            const next = routes.slice();
            const target = index + delta;
            if (target < 0 || target >= next.length) return;
            const current = next[index]!;
            next[index] = next[target]!;
            next[target] = current;
            update(fetchRoutesPath, next);
          };
          return routes.map((route, index) => <div className="ns-fetch-route" key={route.kind}>
            <div className="ns-rule-head">
              <strong>{t(`fetchRoute.${route.kind}`)}</strong>
              <span className="ns-muted">{t(`fetchRouteHelp.${route.kind}`)}</span>
              <div className="ns-actions">
                <button type="button" disabled={!!pending || index === 0} aria-label={t('fetchMoveUp')} onClick={() => move(index, -1)}>↑</button>
                <button type="button" disabled={!!pending || index === routes.length - 1} aria-label={t('fetchMoveDown')} onClick={() => move(index, 1)}>↓</button>
              </div>
            </div>
            <div className="ns-grid">
              {field(`${fetchRoutesPath}.${index}.enabled`, { type: 'checkbox', customLabel: t('fetchEnabled') })}
              {field(`${fetchRoutesPath}.${index}.timeoutMs`, { type: 'number', customLabel: t('fetchTimeout'), help: t('fetchTimeoutHelp'), min: FETCH_BOUNDS.routeTimeoutMs.min, max: FETCH_BOUNDS.routeTimeoutMs.max })}
            </div>
            {fetchRouteStatus(route, index)}
            {ruleEditor(index, route as FetchRouteConfig)}
          </div>);
        }

        function confirmRow(kind: string, text: string, run: () => void, backendId?: string) {
          if (confirming?.kind !== kind) return null;
          return <div className="ns-confirm" role="alert">
            <p>{t(text)}</p>
            <div className="ns-actions"><button type="button" className="ns-danger" onClick={() => { setConfirming(null); run(); }}>{t('confirmYes')}</button><button type="button" onClick={() => setConfirming(null)}>{t('confirmCancel')}</button></div>
          </div>;
        }

        /**
         * One credential control for both operation views. Search and fetch edit the same backend
         * record and the same secret: switching views never asks for the value twice.
         */
        function credentialControl(def: BackendDefinition) {
          const state = snapshot?.credentials[def.id];
          if (!snapshot) return null;
          const disabledReason = pending ? t('credentialPending') : state && !state.writable ? t('credentialReadOnly') : '';
          const disabled = disabledReason !== '';
          const mode = def.modes.find(item => item.mode === (draft.backends[def.id]?.mode || def.modes[0]!.mode));
          return <div className="ns-credential">
            <h5>{t('credentialTitle')}</h5>
            <p>{t(state?.configured ? 'credentialConfigured' : 'credentialMissing')} · {t('credentialHelp')}</p>
            <p className="ns-credential-shape" aria-label={t('credentialShapeLabel')}><code>{mode?.credentialShape?.[lang] ?? t('credentialPlainKey')}</code></p>
            <label htmlFor={`secret-${def.id}`}>{t('credentialValue')}</label>
            <input id={`secret-${def.id}`} type="password" autoComplete="new-password" aria-describedby={`secret-${def.id}-why`} value={secrets[def.id] || ''} disabled={!!pending || disabled} onChange={(event: any) => setSecrets((previous: Record<string, string>) => ({ ...previous, [def.id]: event.target.value }))} />
            {disabledReason && <small id={`secret-${def.id}-why`} className="ns-warning">{disabledReason}</small>}
            <div className="ns-actions">
              <button disabled={!!pending || disabled || !secrets[def.id]} onClick={() => credential(def.id, false)}>{t('replaceCredential')}</button>
              <button disabled={!!pending || disabled || !state?.configured} onClick={() => setConfirming({ kind: `delete-credential-${def.id}`, backendId: def.id })}>{t('deleteCredential')}</button>
            </div>
            {confirmRow(`delete-credential-${def.id}`, 'deleteCredentialConfirm', () => { void credential(def.id, true); })}
          </div>;
        }

        const enabledCount = definitions.filter(def => draft.backends[def.id]?.enabled).length;
        const blockers = snapshot ? blockersOf(draft, definitions.filter(def => def.status === 'documented').map(def => def.id), id => !!snapshot.credentials[id]?.configured, id => definitions.find(def => def.id === id)?.title || id) : [];
        const normalizedQuery = backendQuery.trim().toLowerCase();
        const matches = (def: BackendDefinition) => {
          if (normalizedQuery && !def.title.toLowerCase().includes(normalizedQuery) && !def.id.includes(normalizedQuery)) return false;
          if (backendFilter === 'enabled' && !draft.backends[def.id]?.enabled) return false;
          if (backendFilter === 'configured' && !snapshot?.credentials[def.id]?.configured) return false;
          return true;
        };
        // Group by the cheapest path a backend offers, not by the mode currently selected:
        // a backend with a free option belongs in the free group even while a paid mode is chosen.
        // Cheapest first: no credentials, then no money (own account, own server), then quota-bound free tiers, then spend.
        const TIER_ORDER = ['free', 'account', 'self-hosted', 'allowance', 'trial', 'paid', 'unverified'] as const;
        const tierRank = (tier: string) => { const index = (TIER_ORDER as readonly string[]).indexOf(tier); return index < 0 ? TIER_ORDER.length : index; };
        const bestTier = (def: BackendDefinition) => def.status === 'unverified' ? 'unverified' : def.modes.reduce((best, mode) => tierRank(mode.tier) < tierRank(best) ? mode.tier : best, def.modes[0]?.tier || 'unverified');
        const readyRank = (def: BackendDefinition) => {
          const backend = draft.backends[def.id];
          const selected = def.modes.find(mode => mode.mode === backend?.mode)?.tier;
          return (backend?.enabled ? 0 : 2) + (selected === 'free' ? 0 : 1);
        };
        // One flat list, cheapest first; the chip colour already explains why a backend sits where it does.
        const ranked = definitions.slice().sort((left, right) => tierRank(bestTier(left)) - tierRank(bestTier(right)) || readyRank(left) - readyRank(right) || left.title.localeCompare(right.title));
        const tierRisk = (tier: string) => tier === 'paid' || tier === 'trial' ? 'ns-chip--risk' : tier === 'unverified' ? 'ns-chip--off' : tier === 'allowance' ? 'ns-chip--warn' : 'ns-chip--ok';

        // Search, browser and fetch are separate views over one shared draft: switching tabs never
        // saves, never discards edits, and never moves a value between the operation records.
        const TABS = ['behavior', 'reliability', 'diagnostics', 'backends', 'browser', 'fetch'] as const;
        const verificationCurrent = !!verification && verification.endpoint === draft.browser.endpoint.trim() && verification.tokenEpoch === tokenEpoch && !secrets.browser;
        const verificationStale = !!verification && !verificationCurrent;
        // The floating error card is the alert surface while it is open; the in-page list would be a
        // second copy of the same banner and is shown again once the card is dismissed.
        const showingError = feedback?.kind === 'error';
        const statusText = notice ? t(notice) : !snapshot ? t('loading') : dirty ? tr('unsavedWithErrors', { errors: issues.length }) : t('upToDate');
        /**
         * Save feedback floats above the settings modal instead of sitting at the top of a scrolled
         * page. It is portalled to `document.body` because this page is rendered inside a fixed modal
         * with its own scroll container: an in-page banner can be scrolled out of view, and a host
         * slot would render below the modal (the frame's overlay layer is z-index 20, the modal 1000).
         * The portal disappears with this component, so nothing outlives the page.
         */
        function feedbackLayer() {
          const titleId = 'ns-feedback-title';
          const describeId = 'ns-feedback-body';
          if (!feedback && pending !== 'save') return null;
          const described = feedback && (feedback.text || feedback.detail) ? { 'aria-describedby': describeId } : {};
          const card = !feedback
            ? <div className="ns-feedback ns-feedback--pending" role="status" aria-live="polite" ref={feedbackCard} onKeyDown={feedbackKeyDown}><p className="ns-feedback-text">{t('saving')}</p></div>
            : feedback.kind === 'success'
              ? <div className="ns-feedback ns-feedback--success" role="status" aria-live="polite" ref={feedbackCard} onKeyDown={feedbackKeyDown}><p className="ns-feedback-text">{feedback.text}</p><button type="button" className="ns-link" onClick={dismissFeedback}>{t('feedbackDismiss')}</button></div>
              : <div className="ns-feedback ns-feedback--error" role="alertdialog" aria-labelledby={titleId} {...described} tabIndex={-1} ref={feedbackCard} onKeyDown={feedbackKeyDown}>
                  <h4 id={titleId}>{feedback.title}</h4>
                  <div id={describeId}>
                    {feedback.text && <p className="ns-feedback-text">{feedback.text}</p>}
                    {feedback.detail && <p className="ns-feedback-detail">{feedback.detail}</p>}
                    {!!feedback.issues.length && <ul className="ns-feedback-list">{feedback.issues.map((issue: ConfigIssue, index: number) => <li key={`${issue.path}-${index}`}><button type="button" className="ns-link" onClick={() => { dismissFeedback(); focusIssue(issue); }}>{pathLabel(issue.path)} — {issueText(issue)}</button></li>)}</ul>}
                  </div>
                  <div className="ns-actions"><button type="button" onClick={dismissFeedback}>{t('feedbackDismiss')}</button></div>
                </div>;
          const layer = <div className="ns-feedback-layer" data-nite-search-feedback="">{card}</div>;
          return typeof document === 'undefined' || !ReactDOM?.createPortal ? layer : ReactDOM.createPortal(layer, document.body);
        }
        return <div className="ns-page" aria-busy={!!pending}>
          <style>{styles}{overrides}</style>
          <header className="ns-header"><div><h2 className="ns-page-title">{t('title')}</h2><p>{tr('intro', { enabled: enabledCount, total: definitions.length })}</p></div></header>
          {!!issues.length && !showingError && <div className="ns-summary" role="alert" tabIndex={-1} ref={summary}><h3>{t('validationTitle')}</h3><ul>{issues.map((issue: ConfigIssue, index: number) => <li key={`${issue.path}-${index}`}><a href={`#${fieldId(issue.action?.target || issue.path)}`} onClick={(event: any) => { event.preventDefault(); focusIssue(issue); }}>{pathLabel(issue.path)} <code>{issue.path}</code> — {issueText(issue)}</a></li>)}</ul></div>}
          {snapshot && !snapshot.active.isSelf && <div className="ns-blockers ns-blockers--info" role="status"><h3>{t('activeTitle')}</h3><p>{tr('activeOther', { provider: snapshot.active.searchProvider || t('notSpecified') })}</p><button type="button" disabled={!!pending} onClick={() => action('activate')}>{t('activateSelf')}</button></div>}
          {!!blockers.length && <div className="ns-blockers" role="status" aria-live="polite"><h3>{t('blockersTitle')}</h3><ul>{blockers.map(blocker => <li key={blocker.key}>{tr(blocker.key, blocker.vars)} <button type="button" className="ns-link" onClick={() => focusPath(blocker.jump)}>{t('fixIt')}</button></li>)}</ul></div>}
          {!snapshot ? <button disabled={!!pending} onClick={async () => { setPending('load'); try { const next = await refresh(); setDraft(clone(next.config)); setNotice(''); setFailed(false); } catch { setFailed(true); setNotice('loadFailed'); } finally { setPending(''); } }}>{t('reload')}</button> : <>
          <div className="ns-tabs" role="tablist" aria-label={t('tabsLabel')}>
            {TABS.map(id => <button key={id} role="tab" type="button" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className={`ns-tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>{t(`tab.${id}`)}{id === 'backends' && <span className="ns-tab-count">{enabledCount}/{definitions.length}</span>}{id === 'browser' && <span className="ns-tab-count">{browserDependents.length}</span>}{id === 'fetch' && <span className="ns-tab-count">{draft.pageFetch.routes.filter((route: FetchRouteConfig) => route.enabled).length}/{draft.pageFetch.routes.length}</span>}</button>)}
          </div>
          {tab === 'behavior' && <div role="tabpanel" id="panel-behavior" aria-labelledby="tab-behavior">
            <section className="ns-card" aria-labelledby="sec-behavior"><h3 id="sec-behavior">{t('general')}</h3><div className="ns-grid">{fields(['safeSearch', 'tools.webSearchPlus', 'tools.compactByDefault', 'maxResults', 'concurrency', 'overallTimeoutMs', 'language', 'region', 'recency', 'includeDomains', 'excludeDomains', 'dedup', 'fusion'], { 'tools.webSearchPlus': { type: 'checkbox' }, 'tools.compactByDefault': { type: 'checkbox' }, maxResults: { type: 'number' }, concurrency: { type: 'number' }, overallTimeoutMs: { type: 'number' }, language: { choices: [...LANGUAGES] }, region: { choices: [...REGIONS] }, recency: { choices: ['any', 'day', 'week', 'month', 'year'] }, safeSearch: { type: 'checkbox' }, includeDomains: { type: 'list' }, excludeDomains: { type: 'list' }, dedup: { choices: ['url', 'url-title'] }, fusion: { choices: ['rrf', 'ordered'] } })}</div></section>
          </div>}
          {tab === 'reliability' && <div role="tabpanel" id="panel-reliability" aria-labelledby="tab-reliability">
            {section('resilience', ['sec-resilience'], ['retry.enabled', 'breaker.enabled', 'retry.maxRetries', 'retry.initialDelayMs', 'retry.maxDelayMs', 'retry.networkErrors', 'retry.timeouts', 'breaker.threshold', 'breaker.cooldownMs'], { 'retry.enabled': { type: 'checkbox' }, 'retry.maxRetries': { type: 'number' }, 'retry.initialDelayMs': { type: 'number' }, 'retry.maxDelayMs': { type: 'number' }, 'retry.networkErrors': { type: 'checkbox' }, 'retry.timeouts': { type: 'checkbox' }, 'breaker.enabled': { type: 'checkbox' }, 'breaker.threshold': { type: 'number' }, 'breaker.cooldownMs': { type: 'number' } })}
            {draft.retry.enabled && <section className="ns-card" aria-labelledby="sec-retry-statuses"><h3 id="sec-retry-statuses">{t('field.retry.statuses')}</h3><p className="ns-muted">{t('help.retry.statuses')}</p><div className="ns-statuses">{RETRY_STATUSES.map(code => <label key={code} className="ns-status-choice"><input type="checkbox" checked={draft.retry.statuses.includes(code)} disabled={!!pending} onChange={(event: any) => update('retry.statuses', event.target.checked ? [...draft.retry.statuses, code].sort((a, b) => a - b) : draft.retry.statuses.filter((item: number) => item !== code))} /><span>{code}</span></label>)}</div>{!!issues.filter((issue: ConfigIssue) => issue.path === 'retry.statuses').length && <p className="ns-error" role="alert">{issueText(issues.find((issue: ConfigIssue) => issue.path === 'retry.statuses')!)}</p>}</section>}
            {section('storage', ['sec-storage'], ['cache.enabled', 'diagnostics.enabled', 'cache.ttlSeconds', 'cache.maxEntries', 'diagnostics.maxEntries'], { 'cache.enabled': { type: 'checkbox' }, 'cache.ttlSeconds': { type: 'number' }, 'cache.maxEntries': { type: 'number' }, 'diagnostics.enabled': { type: 'checkbox' }, 'diagnostics.maxEntries': { type: 'number' } })}
          </div>}
          {tab === 'diagnostics' && <div role="tabpanel" id="panel-diagnostics" aria-labelledby="tab-diagnostics">
            <section className="ns-card" aria-labelledby="sec-test"><h3 id="sec-test">{t('testTitle')}</h3><p>{t('testHelp')}</p>{enabledSaved.length === 0 ? <p className="ns-muted">{t('testNeedsBackend')}</p> : <div className="ns-grid"><div className="ns-field"><label htmlFor="ns-test-backend">{t('testBackend')}</label><select id="ns-test-backend" disabled={!!pending || dirty} value={testBackend} onChange={(event: any) => setTestBackend(event.target.value)}>{enabledSaved.map(def => <option value={def.id} key={def.id}>{def.title}</option>)}</select></div><div className="ns-field"><label htmlFor="ns-test-query">{t('testQuery')}</label><input id="ns-test-query" value={query} disabled={!!pending || dirty} onChange={(event: any) => setQuery(event.target.value)} placeholder={t('testQueryPlaceholder')} /></div></div>}
              {enabledSaved.length > 0 && <div className="ns-test-actions"><button className="ns-primary" disabled={!!pending || dirty || !query.trim() || !enabledSaved.some(def => def.id === testBackend)} onClick={() => action('test', { backendId: testBackend, query })}>{t('runTest')}</button>{dirty && <small>{t('saveBeforeTest')}</small>}</div>}
              {testResult && <div className="ns-result"><h4>{t('testResult')}</h4>{testResult.sources?.length ? <ol className="ns-sources">{testResult.sources.map((source: any, index: number) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a><p className="ns-muted">{source.url}</p>{source.snippet && <p>{source.snippet}</p>}</li>)}</ol> : <p className="ns-muted">{t('noSources')}</p>}
                {(testResult.outcomes || []).filter((outcome: BackendOutcome) => !outcome.ok).map((outcome: BackendOutcome) => <div className="ns-failure" key={outcome.backend}><h5>{t('testFailure')}</h5><dl><dt>{t('diagnostic.backend')}</dt><dd>{outcome.backend}</dd><dt>{t('diagnostic.mode')}</dt><dd>{t(`choice.${outcome.mode}`)}</dd><dt>{t('diagnostic.attempts')}</dt><dd>{outcome.attempts}</dd><dt>{t('diagnostic.reason')}</dt><dd>{t(`failure.${outcome.error?.kind || 'protocol'}`)}{outcome.error?.status ? ` · HTTP ${outcome.error.status}` : ''}</dd><dt>{t('diagnostic.message')}</dt><dd>{outcome.error?.message}</dd></dl></div>)}
                {(testResult.outcomes || []).flatMap((outcome: BackendOutcome) => outcome.warnings.map(warning => <p className="ns-muted" key={`${outcome.backend}-${warning}`}>[{outcome.backend}] {warning}</p>))}
              </div>}</section>
            <section className="ns-card" aria-labelledby="sec-diagnostics"><h3 id="sec-diagnostics">{t('diagnosticsTitle')}</h3><p>{t('diagnosticsHelp')}</p><div className="ns-actions"><button disabled={!!pending} onClick={() => action('clear-cache')}>{t('clearCache')}</button><button disabled={!!pending} onClick={() => setConfirming({ kind: 'clear-diagnostics' })}>{t('clearDiagnostics')}</button><button disabled={!!pending} onClick={async () => { setPending('refresh'); try { await refresh(); setNotice('done'); setFailed(false); } catch { setFailed(true); setNotice('actionFailed'); } finally { setPending(''); } }}>{t('refreshDiagnostics')}</button></div>{confirmRow('clear-diagnostics', 'clearDiagnosticsConfirm', () => { void action('clear-diagnostics'); })}
              {snapshot.diagnostics.length ? <div className="ns-table-wrap"><table><thead><tr>{['time', 'backend', 'mode', 'result', 'attempts', 'message'].map(key => <th key={key}>{t(`diagnostic.${key}`)}</th>)}</tr></thead><tbody>{[...snapshot.diagnostics].reverse().map((item: BackendOutcome, index: number) => <tr key={`${item.backend}-${index}`}><td>{item.at ? new Date(item.at).toLocaleTimeString(locale.active) : '—'}</td><td>{item.backend}</td><td>{t(`choice.${item.mode}`)}</td><td className={item.ok ? 'ns-success' : 'ns-error'}>{item.ok ? t('ok') : t(`failure.${item.error?.kind || 'protocol'}`)}</td><td>{item.attempts}</td><td className="ns-cell-message">{item.ok ? (item.warnings[0] ? t('hasWarnings') : '') : (item.error?.message || '')}</td></tr>)}</tbody></table></div> : <p className="ns-muted">{t('noDiagnostics')}</p>}</section>
            <section className="ns-card" aria-labelledby="sec-transfer"><h3 id="sec-transfer">{t('transferTitle')}</h3><p>{t('transferHelp')}</p><div className="ns-actions"><button disabled={!!pending} onClick={exportConfig}>{t('export')}</button><button disabled={!!pending} aria-expanded={showTransfer} onClick={() => setShowTransfer(!showTransfer)}>{t('import')}</button><button disabled={!!pending} onClick={() => setConfirming({ kind: 'restore-defaults' })}>{t('restoreDefaults')}</button></div>{confirmRow('restore-defaults', 'defaultsConfirm', () => { setDraft(clone(snapshot.defaults)); setIssues([]); setNotice('defaultsRestored'); })}{showTransfer && <div className="ns-field"><label htmlFor="ns-import">{t('importLabel')}</label><textarea id="ns-import" value={importText} disabled={!!pending} onChange={(event: any) => setImportText(event.target.value)} rows={8} /><button disabled={!!pending || !importText.trim()} onClick={importConfig}>{t('applyImport')}</button></div>}</section>
          </div>}
          {tab === 'fetch' && <div role="tabpanel" id="panel-fetch" aria-labelledby="tab-fetch">
            <section className="ns-card" aria-labelledby="sec-fetch-tool"><h3 id="sec-fetch-tool">{t('fetchToolTitle')}</h3><p className="ns-muted">{t('fetchToolHelp')}</p><div className="ns-grid">{fields(['tools.webExtract'], { 'tools.webExtract': { type: 'checkbox' } })}</div></section>
            <section className="ns-card" aria-labelledby="sec-fetch-ready"><h3 id="sec-fetch-ready">{t('fetchReadyTitle')}</h3>
              {fetchReady ? <p className="ns-success">{t('fetchReady')}</p> : <ul className="ns-fetch-problems">{fetchProblems.map(problem => <li key={problem.key} className="ns-warning">{tr(`problem.${problem.key}`, problem.vars || {})}</li>)}</ul>}
              <p className="ns-muted">{t('fetchReadyHelp')}</p>
            </section>
            <section className="ns-card" aria-labelledby="sec-fetch-routes"><h3 id="sec-fetch-routes">{t('fetchRoutesTitle')}</h3><p className="ns-muted">{t('fetchRoutesHelp')}</p><div id={fetchRoutesPath}>{fetchRouteRows()}</div></section>
            <section className="ns-card" aria-labelledby="sec-fetch-provider"><h3 id="sec-fetch-provider">{t('fetchProviderTitle')}</h3><p className="ns-muted">{t('fetchProviderHelp')}</p>
              {selectedFetchProvider && <div className="ns-provider-summary">
                <p><strong>{selectedFetchProvider.title}</strong> · {tr('fetchProviderServes', { formats: selectedFetchProvider.serves.join(', ') })} · {t('fetchMode')}: {draft.backends[selectedFetchProvider.id]?.fetch.mode || t('notSpecified')}</p>
                <p className={selectedFetchProvider.credentialRequired && !selectedFetchProvider.credentialConfigured ? 'ns-warning' : 'ns-muted'}>{selectedFetchProvider.credentialRequired ? t(selectedFetchProvider.credentialConfigured ? 'credentialConfigured' : 'credentialMissing') : t('credentialNotRequired')}</p>
                <div className="ns-actions"><button type="button" className="ns-link" onClick={() => focusPath(`backends.${selectedFetchProvider.id}.fetch.mode`)}>{t('openSetting')}</button><a href={selectedFetchProvider.docs} target="_blank" rel="noreferrer">{t('docs')}</a></div>
              </div>}
              <div className="ns-field">
                <label htmlFor={fieldId('pageFetch.providerId')}>{t('fetchProviderSelect')}</label>
                <select id={fieldId('pageFetch.providerId')} value={draft.pageFetch.providerId} disabled={!!pending} onChange={(event: any) => update('pageFetch.providerId', event.target.value)}>
                  <option value="">{t('fetchProviderNone')}</option>
                  {fetchProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.title}</option>)}
                </select>
                <small>{t('fetchProviderSelectionHelp')}</small>
              </div>
              <div className="ns-provider-list">
              {fetchProviders.map((provider: FetchProviderInfo) => {
                const def = definitions.find(item => item.id === provider.id)!;
                const backend = draft.backends[def.id]!;
                const modeLabel = draft.backends[def.id]?.fetch.mode || '';
                const selected = draft.pageFetch.providerId === def.id;
                const modeEvidence = def.fetch?.evidence?.[modeLabel as AccessMode];
                // A provider card is never opened by selection: the summary says which provider is
                // selected, and only the user's own click unfolds the settings of a card.
                return <details className="ns-card ns-backend ns-provider-card" key={`fetch-${def.id}`}>
                  <summary>
                    <span className="ns-backend-title">{def.title}</span>
                    <span className="ns-chips">
                      {provider.modes.map(mode => <span key={mode} className={`ns-chip ${mode === modeLabel ? 'is-on' : ''}`} title={t(`choice.${mode}`)}>{t(`choice.${mode}`)}</span>)}
                      <span className={`ns-dot ${snapshot?.credentials[def.id]?.configured ? 'is-on' : 'is-off'}`} aria-hidden="true" />
                      <span className={`ns-badge ${selected ? 'is-on' : ''}`}>{selected ? t('fetchProviderSelected') : t('fetchProviderNotSelected')}</span>
                    </span>
                  </summary>
                  <div className="ns-backend-body">
                    <p className="ns-quota">{tr('fetchProviderServes', { formats: provider.serves.join(', ') })} · <a href={provider.docs} target="_blank" rel="noreferrer">{t('docs')}</a> · {t('verifiedAt')} {provider.verifiedAt}</p>
                    <p className="ns-chips ns-mode-evidence">{provider.modes.map(mode => {
                      const evidence = def.fetch?.evidence?.[mode as AccessMode];
                      const documented = evidence?.evidence === 'documented';
                      const date = evidence?.verifiedAt ?? provider.verifiedAt;
                      return <span key={mode} className={`ns-chip ${documented ? 'ns-chip--off' : 'is-on'}`} title={tr(documented ? 'fetchEvidenceDocumented' : 'fetchEvidenceLive', { date })}>{t(`choice.${mode}`)}</span>;
                    })}</p>
                    {modeEvidence?.evidence === 'documented' && <p className="ns-warning">{t('fetchModeDocumentedOnly')}{modeEvidence.source && <> <a href={modeEvidence.source} target="_blank" rel="noreferrer">{t('docs')}</a></>}</p>}
                    {provider.notes && <p className="ns-muted">{provider.notes[lang]}</p>}
                    <p className={provider.credentialRequired && !provider.credentialConfigured ? 'ns-warning' : 'ns-muted'}>{provider.credentialRequired ? t(provider.credentialConfigured ? 'credentialConfigured' : 'credentialMissing') : t('credentialNotRequired')}</p>
                    {!provider.serves.includes('html') && <p className="ns-muted">{t('fetchProviderMarkdownOnly')}</p>}
                    <p className="ns-muted">{t('fetchSearchCapsNote')}</p>
                    <div className="ns-grid">
                      {field(`backends.${def.id}.fetch.mode`, { choices: def.fetch?.modes || [], customLabel: t('fetchMode'), help: t('fetchModeHelp') })}
                      {field(`backends.${def.id}.fetch.endpoint`, { customLabel: t('fetchEndpoint'), help: t('fetchEndpointHelp') })}
                      {field(`backends.${def.id}.fetch.timeoutMs`, { type: 'number', customLabel: t('fetchTimeout'), help: t('fetchProviderTimeoutHelp'), min: FETCH_BOUNDS.routeTimeoutMs.min, max: FETCH_BOUNDS.routeTimeoutMs.max })}
                    </div>
                    {def.fetch && def.fetch.options.length > 0 && <details className="ns-advanced"><summary>{t('advancedOptions')}</summary><div className="ns-grid">{def.fetch.options.map(option => field(`backends.${def.id}.fetch.options.${option.key}`, { type: option.type === 'boolean' ? 'checkbox' : option.type === 'number' ? 'number' : 'text', choices: option.choices, help: option.help[lang], customLabel: option.label[lang], min: option.min, max: option.max }))}</div></details>}
                    {/* One credential per provider: a keyed fetch uses the same stored secret as the
                        provider's search mode, so the fetch tab links to that control instead of
                        asking for a second copy of the same key. */}
                    {modeLabel !== 'anonymous' && <div className="ns-credential-shared">
                      <p className="ns-muted">{t('fetchCredentialShared')}</p>
                      <div className="ns-actions"><button type="button" className="ns-link" onClick={() => focusPath(`backends.${def.id}.mode`)}>{t('openCredential')}</button></div>
                    </div>}
                    <p className="ns-meta"><span>{t('attemptsToday')} <strong>{snapshot?.counters[def.id]?.attempts ?? 0}</strong></span><span aria-hidden="true">·</span><span>{snapshot?.counters[def.id]?.day ?? t('noData')}</span></p>
                  </div>
                </details>;
              })}
              </div>
            </section>
            {section('fetchLimitsTitle', ['sec-fetch-limits'], ['pageFetch.overallTimeoutMs', 'pageFetch.maxRedirects', 'pageFetch.maxBodyBytes', 'pageFetch.maxOutputChars', 'pageFetch.maxRuleScanChars', 'pageFetch.allowPrivateNetworks', 'pageFetch.browser.context', 'pageFetch.browser.settleMs', 'pageFetch.browser.selectorWait'], {
              'pageFetch.overallTimeoutMs': { type: 'number', min: FETCH_BOUNDS.overallTimeoutMs.min, max: FETCH_BOUNDS.overallTimeoutMs.max },
              'pageFetch.maxRedirects': { type: 'number', min: FETCH_BOUNDS.maxRedirects.min, max: FETCH_BOUNDS.maxRedirects.max },
              'pageFetch.maxBodyBytes': { type: 'number', min: FETCH_BOUNDS.maxBodyBytes.min, max: FETCH_BOUNDS.maxBodyBytes.max },
              'pageFetch.maxOutputChars': { type: 'number', min: FETCH_BOUNDS.maxOutputChars.min, max: FETCH_BOUNDS.maxOutputChars.max },
              'pageFetch.maxRuleScanChars': { type: 'number', min: FETCH_BOUNDS.maxRuleScanChars.min, max: FETCH_BOUNDS.maxRuleScanChars.max },
              'pageFetch.allowPrivateNetworks': { type: 'checkbox' },
              'pageFetch.browser.context': { choices: ['isolated', 'session'] },
              'pageFetch.browser.settleMs': { type: 'number', min: FETCH_BOUNDS.settleMs.min, max: FETCH_BOUNDS.settleMs.max },
            })}
            <section className="ns-card" aria-labelledby="sec-fetch-test"><h3 id="sec-fetch-test">{t('fetchTestTitle')}</h3><p>{t('fetchTestHelp')}</p>
              <div className="ns-grid">
                <div className="ns-field"><label htmlFor="ns-fetch-url">{t('fetchTestUrl')}</label><input id="ns-fetch-url" value={fetchTestUrl} disabled={!!pending || dirty} onChange={(event: any) => setFetchTestUrl(event.target.value)} placeholder="https://example.com/page" /></div>
                <div className="ns-field"><label htmlFor="ns-fetch-format">{t('fetchTestFormat')}</label><select id="ns-fetch-format" value={fetchTestFormat} disabled={!!pending || dirty} onChange={(event: any) => setFetchTestFormat(event.target.value)}><option value="markdown">{t('fetchFormat.markdown')}</option><option value="html">{t('fetchFormat.html')}</option></select></div>
              </div>
              <div className="ns-test-actions"><button className="ns-primary" disabled={!!pending || dirty || !fetchTestUrl.trim()} onClick={() => action('fetch-test', { url: fetchTestUrl.trim(), format: fetchTestFormat })}>{t('runTest')}</button>{dirty && <small>{t('saveBeforeTest')}</small>}</div>
              {fetchTestResult && <div className="ns-result"><h4>{t('fetchTestResult')}</h4><pre>{fetchTestResult.text ?? JSON.stringify(fetchTestResult, null, 2)}</pre></div>}
            </section>
          </div>}
          {tab === 'browser' && <div role="tabpanel" id="panel-browser" aria-labelledby="tab-browser">
            <section className="ns-card" aria-labelledby="sec-browser"><h3 id="sec-browser">{t('sharedBrowser')}</h3><p className="ns-muted">{t('sharedBrowserHint')}</p>
              <div className="ns-grid">{fields(['browser.endpoint', 'browser.statePath', 'browser.timeoutMs', 'browser.maxConcurrentReads'], { 'browser.timeoutMs': { type: 'number' }, 'browser.maxConcurrentReads': { type: 'number' } })}</div>
              {!!snapshot && <div className="ns-credential"><h5>{t('browserTokenTitle')}</h5><p>{t(snapshot.browser.credentialConfigured ? 'credentialConfigured' : 'credentialMissing')} · {t('browserTokenHelp')}</p><label htmlFor="secret-browser">{t('browserTokenValue')}</label><input id="secret-browser" type="password" autoComplete="new-password" value={secrets.browser || ''} disabled={!!pending || !snapshot.browser.writable} onChange={(event: any) => setSecrets((previous: Record<string, string>) => ({ ...previous, browser: event.target.value }))} /><div className="ns-actions"><button disabled={!!pending || !snapshot.browser.writable || !secrets.browser} onClick={() => browserCredential(false)}>{t('saveToken')}</button><button disabled={!!pending || !snapshot.browser.writable || !snapshot.browser.credentialConfigured} onClick={() => setConfirming({ kind: 'delete-browser-credential' })}>{t('deleteCredential')}</button></div>{confirmRow('delete-browser-credential', 'deleteCredentialConfirm', () => { void browserCredential(true); })}</div>}
            </section>
            <section className="ns-card" aria-labelledby="sec-browser-dependents"><h3 id="sec-browser-dependents">{t('browserDependentsTitle')}</h3>
              <p className="ns-muted">{t('browserConnectionNotLogin')}</p>
              <p className="ns-muted">{t('browserDependentsHelp')}</p>
              {browserDependents.length ? <ul className="ns-dependent-list">{browserDependents.map(dependent => <li key={dependent.key}>
                <span className={`ns-dot ${dependent.source === 'missing' ? 'is-off' : 'is-on'}`} aria-hidden="true" />
                <strong>{dependent.title}</strong>
                <span className="ns-muted">{dependent.source === 'shared' ? tr('browserDependencyShared', { endpoint: dependent.endpoint }) : dependent.source === 'own' ? tr('browserDependencyOwn', { endpoint: dependent.endpoint }) : t('browserDependencyMissing')}</span>
                <span className="ns-actions"><button type="button" className="ns-link" onClick={() => focusPath(dependent.jump)}>{t('openSetting')}</button>{dependent.fix && <button type="button" className="ns-link" onClick={() => focusPath(dependent.fix!)}>{t('fixIt')}</button>}</span>
              </li>)}</ul> : <p className="ns-muted">{t('browserNoDependents')}</p>}
              <div className="ns-test-actions">
                <button className="ns-primary" disabled={!!pending || !draft.browser.endpoint.trim()} onClick={verifyConnection}>{t('browserCheck')}</button>
                {!draft.browser.endpoint.trim() && <small>{t('browserCheckNeedsEndpoint')}</small>}
              </div>
              {verificationCurrent && <div className={`ns-verification ${verification!.ok ? 'ns-success' : 'ns-error'}`} role="status">
                <p>{verification!.ok ? (verification!.source === 'save' ? t('browserCheckSavedVerified') : tr('browserCheckOk', { endpoint: verification!.endpoint, duration: verification!.durationMs })) : tr('browserCheckFailed', { endpoint: verification!.endpoint })}</p>
                {!verification!.ok && verification!.code && <p>{known(`issue.${verification!.code}`) ? tr(`issue.${verification!.code}`, { endpoint: verification!.endpoint }) : verification!.code}</p>}
                <p className="ns-muted">{t('browserCheckSavedNotRequired')}</p>
              </div>}
              {verificationStale && <p className="ns-muted">{t('browserCheckStale')}</p>}
              {!!browserGateIssues(draft).length && <ul className="ns-fetch-problems">{browserGateIssues(draft).map(issue => <li key={`${issue.path}-${issue.code}`} className="ns-warning">{issueText(issue)} <button type="button" className="ns-link" onClick={() => focusIssue(issue)}>{t('fixIt')}</button></li>)}</ul>}
            </section>
          </div>}
          {tab === 'backends' && <div role="tabpanel" id="panel-backends" aria-labelledby="tab-backends">
            <section className="ns-backends" id="sec-backends" tabIndex={-1} aria-labelledby="sec-backends-title">
              <h3 id="sec-backends-title">{t('backends')} <span className="ns-muted">{tr('enabledSummary', { enabled: enabledCount, total: definitions.length })}</span></h3>
              <p className="ns-muted">{t('backendIntro')} {t('colorLegend')}</p>
              <div className="ns-toolbar">
                <div className="ns-field"><label htmlFor="ns-backend-search">{t('searchBackends')}</label><input id="ns-backend-search" type="search" value={backendQuery} onChange={(event: any) => setBackendQuery(event.target.value)} placeholder={t('searchBackendsPlaceholder')} /></div>
                <div className="ns-field"><label htmlFor="ns-backend-filter">{t('filterBackends')}</label><select id="ns-backend-filter" value={backendFilter} onChange={(event: any) => setBackendFilter(event.target.value)}>{['all', 'enabled', 'configured'].map(value => <option key={value} value={value}>{t(`filter.${value}`)}</option>)}</select></div>
              </div>
              {ranked.filter(matches).map(def => {
                const backend = draft.backends[def.id]; if (!backend) return null;
                const mode = def.modes.find(item => item.mode === backend.mode); const base = `backends.${def.id}`; const credentialState = snapshot.credentials[def.id]; const locked = def.status !== 'documented'; const anonymous = backend.mode === 'anonymous'; const readsThroughBrowser = backend.mode === 'browser';
                return <details className="ns-card ns-backend" key={def.id}><summary><span className="ns-backend-title">{def.title}</span><span className="ns-chips">{def.modes.map(item => <span key={item.mode} className={`ns-chip ${item.mode === backend.mode ? 'is-on' : ''} ${item.tier === 'unverified' ? 'ns-chip--off' : tierRisk(item.tier)}`} aria-current={item.mode === backend.mode ? 'true' : undefined} title={t(`choice.${item.mode}`)}>{t(`choice.${item.mode}`)} · {t(`tier.${item.tier}`)}</span>)}{locked && <span className="ns-chip ns-chip--off">{t('unverified')}</span>}<span className={`ns-dot ${credentialState?.configured ? 'is-on' : 'is-off'}`} aria-hidden="true" /><span className={`ns-badge ${backend.enabled ? 'is-on' : ''}`}>{backend.enabled ? t('enabled') : t('disabled')}</span></span></summary>
                  <div className="ns-backend-body">
                    {locked && <p className="ns-warning">{t('unverifiedHelp')}</p>}
                    <p className="ns-quota">{mode?.limits[lang]} <a href={mode?.pricingUrl || def.docs} target="_blank" rel="noreferrer">{t('source')}</a> · {t('verifiedAt')} {def.verifiedAt || t('notVerified')}</p>
                    <div className="ns-grid">{fields(readsThroughBrowser ? [`${base}.enabled`, `${base}.mode`, `${base}.timeoutMs`, `${base}.rateLimitPerMinute`, `${base}.dailyAttemptLimit`] : [`${base}.enabled`, `${base}.mode`, `${base}.endpoint`, `${base}.timeoutMs`, `${base}.rateLimitPerMinute`, `${base}.dailyAttemptLimit`], { [`${base}.enabled`]: { type: 'checkbox', disabled: locked }, [`${base}.mode`]: { choices: def.modes.map(item => item.mode), disabled: locked }, [`${base}.timeoutMs`]: { type: 'number' }, [`${base}.rateLimitPerMinute`]: { type: 'number' }, [`${base}.dailyAttemptLimit`]: { type: 'number' } })}</div>
                    {readsThroughBrowser && <div className="ns-inherit">
                      <p>{draft.browser.endpoint ? tr('browserInheritedEndpoint', { endpoint: draft.browser.endpoint }) : backend.endpoint ? tr('browserOwnEndpoint', { endpoint: backend.endpoint }) : t('browserInheritedEndpointMissing')}{!draft.browser.endpoint && !backend.endpoint && <button type="button" className="ns-link" onClick={() => focusPath('browser.endpoint')}>{t('fixIt')}</button>}</p>
                      <p className="ns-muted">{t('browserInheritedHint')}</p>
                      <details className="ns-advanced"><summary>{t('browserOverride')}</summary><p className="ns-muted">{t('browserOverrideHint')}</p><div className="ns-grid">{fields([`${base}.endpoint`])}</div></details>
                    </div>}
                    {anonymous && !locked && <p className="ns-muted">{t('anonymousNoCredential')}</p>}
                    {def.options.length > 0 && <details className="ns-advanced"><summary>{t('advancedOptions')}</summary><div className="ns-grid">{def.options.map(option => field(`${base}.options.${option.key}`, { type: option.type === 'boolean' ? 'checkbox' : option.type === 'number' ? 'number' : 'text', choices: option.choices, help: option.help[lang], customLabel: option.label[lang], disabled: locked, min: option.min, max: option.max }))}</div></details>}
                    {!anonymous && !locked && !readsThroughBrowser && credentialControl(def)}
                    <p className="ns-meta"><span>{t('attemptsToday')} <strong>{snapshot.counters[def.id]?.attempts ?? 0}</strong></span><span aria-hidden="true">·</span><span>{snapshot.counters[def.id]?.day ?? t('noData')}</span></p>
                  </div>
                </details>;
              })}
              {!definitions.some(matches) && <p className="ns-muted">{t('noMatch')}</p>}
            </section>
          </div>}
          <footer className="ns-footer"><span aria-live="polite" className={failed ? 'ns-error' : ''}>{statusText}</span><div className="ns-actions"><button disabled={!!pending || !dirty} onClick={() => setConfirming({ kind: 'discard' })}>{t('discard')}</button><button ref={saveButton} className="ns-primary" disabled={!!pending || !dirty} onClick={save}>{t(pending === 'save' ? 'saving' : 'save')}</button></div>{confirmRow('discard', 'discardConfirm', () => { setDraft(clone(snapshot.config)); setIssues([]); setNotice(''); })}</footer>
          </>}
          {feedbackLayer()}
        </div>;
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'nite-search', order: 16, label: () => t('title') }, Page));
    },
  };
}
