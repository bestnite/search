import styles from './client.css';
import overrides from './client.overrides.css';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import { defaultConfig, validateConfig } from './config';
import { blockersOf, visible } from './visibility';
import { LANGUAGES, REGIONS } from './locale-map';
import { catalog } from './catalog';
import type { BackendDefinition, BackendOutcome, ConfigIssue, SearchConfig, SettingsSnapshot } from './types';

const API = '/api/nite-search';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ranges: Record<string, [number, number]> = { maxResults: [1, 50], concurrency: [1, 20], overallTimeoutMs: [1000, 180000], 'retry.maxRetries': [0, 5], 'retry.initialDelayMs': [0, 60000], 'retry.maxDelayMs': [0, 120000], 'cache.ttlSeconds': [1, 86400], 'cache.maxEntries': [1, 1000], 'breaker.threshold': [1, 100], 'breaker.cooldownMs': [1000, 3600000], 'diagnostics.maxEntries': [1, 500], 'backend.timeoutMs': [1000, 120000], 'backend.rateLimitPerMinute': [0, 100000], 'backend.dailyAttemptLimit': [0, 1000000] };
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];
const fieldId = (path: string) => `nite-search-${path.replace(/[^a-z0-9-]/gi, '-')}`;
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
async function request(path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${API}/${path}`, { credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/** The build wraps this module once in the DSH lazy module factory. */
export function createClient(React: any) {
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
        const [backendFilter, setBackendFilter] = React.useState('all');
        const [confirming, setConfirming] = React.useState(null as { kind: string; backendId?: string } | null);
        const [tab, setTab] = React.useState('behavior');
        const [pendingFocus, setPendingFocus] = React.useState('');
        const summary = React.useRef(null as HTMLDivElement | null);
        const dirty = !!snapshot && !same(draft, snapshot.config);
        const definitions: BackendDefinition[] = snapshot?.catalog || catalog;
        const enabledSaved = definitions.filter(def => def.status === 'documented' && snapshot?.config.backends[def.id]?.enabled);
        React.useEffect(() => { let live = true; request('settings').then((value: SettingsSnapshot) => { if (live) { setSnapshot(value); setDraft(clone(value.config)); } }).catch(() => { if (live) { setNotice('loadFailed'); setFailed(true); } }); return () => { live = false; }; }, []);
        React.useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
        React.useEffect(() => { if (issues.length) summary.current?.focus(); }, [issues]);
        function update(path: string, value: unknown) {
          setDraft((previous: SearchConfig) => {
            let next = set(previous, path, value);
            const match = /^backends\.([^.]+)\.mode$/.exec(path);
            if (match) { const endpoint = definitions.find(def => def.id === match[1])?.modes.find(mode => mode.mode === value)?.endpoint; if (endpoint) next = set(next, `backends.${match[1]}.endpoint`, endpoint); }
            return next;
          });
          setNotice('');
        }
        function label(path: string) {
          const option = /^backends\.([^.]+)\.options\.(.+)$/.exec(path);
          if (option) return definitions.find(def => def.id === option[1])?.options.find(field => field.key === option[2])?.label[lang] || t('invalidField');
          return t(`field.${path.replace(/^backends\.[^.]+\./, 'backend.')}`);
        }
        /** Reveal the tab that owns a path, then reveal its section and focus the control. */
        function focusPath(path: string) {
          if (path === 'backends' || path === 'sec-backends') { setTab('backends'); setPendingFocus('sec-backends'); return; }
          const reliability = path.startsWith('retry.') || path.startsWith('breaker.') || path.startsWith('cache.') || path === 'diagnostics.enabled' || path === 'diagnostics.maxEntries';
          setTab(path.startsWith('backends.') ? 'backends' : reliability ? 'reliability' : 'behavior');
          setPendingFocus(path);
        }
        React.useEffect(() => {
          if (!pendingFocus) return;
          const target = document.getElementById(fieldId(pendingFocus)) || document.getElementById(pendingFocus);
          if (target) {
            let node: HTMLElement | null = target;
            while (node) { const wrapper: HTMLDetailsElement | null = node.closest('details'); if (!wrapper) break; wrapper.open = true; node = wrapper.parentElement; }
            target.scrollIntoView({ block: 'center' });
            target.focus();
          }
          setPendingFocus('');
        }, [pendingFocus, tab]);
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
            <label htmlFor={id}>{customLabel || label(path)}</label>
            {type === 'checkbox' ? <input {...props} type="checkbox" checked={!!value} onChange={(event: any) => update(path, event.target.checked)} /> : choices ? <select {...props} value={value} onChange={(event: any) => update(path, event.target.value)}>{choices.map(choice => <option key={choice} value={choice}>{path === 'singleBackend' ? definitions.find(def => def.id === choice)?.title || choice : path === 'language' || path === 'region' ? (choice === '' ? t('notSpecified') : choice) : path.includes('.options.') ? choice : t(`choice.${choice}`)}</option>)}</select> : type === 'list' || type === 'numbers' ? <ListInput {...props} value={value} numeric={type === 'numbers'} onCommit={(next: unknown) => update(path, next)} /> : <input {...props} type={type} min={min} max={max} value={value ?? ''} onChange={(event: any) => { const raw = event.target.value; update(path, type === 'number' ? (raw === '' ? '' : Number(raw)) : raw); }} />}
            <small id={`${id}-help`}>{help || t(`help.${path.replace(/^backends\.[^.]+\./, 'backend.')}`)}{type === 'number' && min !== undefined && max !== undefined ? ` (${min}–${max})` : ''}</small>
            {!!errors.length && <small className="ns-error" id={`${id}-error`}>{type === 'number' && min !== undefined && max !== undefined ? tr('expectedRange', { min, max }) : t('invalidField')}<button type="button" className="ns-link" onClick={() => focusPath(path)}>{t('showField')}</button></small>}
          </div>;
        }
        /** Renders a field group, dropping members hidden by their owning switch. */
        function fields(paths: string[], options: Record<string, any> = {}) {
          return paths.filter(path => visible(path, draft)).map(path => field(path, options[path] || {}));
        }
        function section(title: string, ids: string[], paths: string[], options: Record<string, any> = {}) {
          const shown = fields(paths, options);
          return shown.length ? <section className="ns-card" aria-labelledby={ids[0]}><h3 id={ids[0]}>{t(title)}</h3><div className="ns-grid">{shown}</div></section> : null;
        }
        async function refresh() { const next = await request('settings') as SettingsSnapshot; setSnapshot(next); return next; }
        async function save() {
          const errors = validateConfig(draft); setIssues(errors); if (errors.length || !snapshot) return;
          const intended = clone(draft); const revision = snapshot.revision;
          setPending('save'); setNotice('saving'); setFailed(false);
          try {
            // Never replay a mutation: a plugin restart may terminate the response after commit.
            try { await request('settings', { config: intended, expectedRevision: revision }); } catch { /* Confirm the actual saved state below. */ }
            const next = await refresh();
            if (!same(next.config, intended)) { setFailed(true); setNotice(next.revision !== revision ? 'conflict' : 'saveUnconfirmed'); }
            else { setDraft(clone(next.config)); setNotice('saved'); }
          } catch { setFailed(true); setNotice('saveUnconfirmed'); } finally { setPending(''); }
        }
        async function action(actionName: string, extra: Record<string, unknown> = {}) {
          setPending(actionName); setFailed(false); setNotice('working');
          try { const result = await request('action', { action: actionName, ...extra }); if (actionName === 'test') setTestResult(result); await refresh(); setNotice('done'); }
          catch { setFailed(true); setNotice('actionFailed'); } finally { setPending(''); }
        }
        async function credential(id: string, remove: boolean) {
          if (!snapshot) return; const reference = draft.backends[id]?.credentialRef;
          setPending(`credential-${id}`); setFailed(false); setNotice('working');
          try { await request('credential', { backendId: id, ref: reference, ...(remove ? { remove: true } : { value: secrets[id] }) }); setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); await refresh(); setNotice('credentialSaved'); }
          catch { setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); setFailed(true); setNotice('credentialFailed'); } finally { setPending(''); }
        }
        function importConfig() {
          try { const parsed = JSON.parse(importText); const errors = validateConfig(parsed); setIssues(errors); if (errors.length) return; setDraft(clone(parsed)); setImportText(''); setNotice('imported'); setFailed(false); }
          catch { setNotice('importFailed'); setFailed(true); }
        }
        function exportConfig() {
          const blob = new Blob([JSON.stringify(redact(draft), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'nite-search.redacted.json'; link.click(); URL.revokeObjectURL(url);
        }
        function confirmRow(kind: string, text: string, run: () => void, backendId?: string) {
          if (confirming?.kind !== kind) return null;
          return <div className="ns-confirm" role="alert">
            <p>{t(text)}</p>
            <div className="ns-actions"><button type="button" className="ns-danger" onClick={() => { setConfirming(null); run(); }}>{t('confirmYes')}</button><button type="button" onClick={() => setConfirming(null)}>{t('confirmCancel')}</button></div>
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

        const TABS = ['behavior', 'reliability', 'diagnostics', 'backends'] as const;
        const credentialDisabledReason = (id: string): string => {
        if (pending) return t('credentialPending');
        const reference = draft.backends[id]?.credentialRef;
        if (!reference) return t('credentialRefRequired');
        const savedReference = snapshot?.config.backends[id]?.credentialRef;
        if (reference === savedReference && snapshot?.credentials[id] && !snapshot.credentials[id]!.writable) return t('credentialReadOnly');
        return '';
      };
      const credentialDisabled = (id: string): boolean => credentialDisabledReason(id) !== '';
      return <div className="ns-page" aria-busy={!!pending}>
          <style>{styles}{overrides}</style>
          <header className="ns-header"><div><h2>{t('title')}</h2><p>{tr('intro', { enabled: enabledCount, total: definitions.length })}</p></div></header>
          <div className="ns-status" role="status" aria-live="polite"><span className={failed ? 'ns-error' : ''}>{notice ? t(notice) : !snapshot ? t('loading') : dirty ? t('unsaved') : t('upToDate')}</span>{!!pending && <span>{t('pending')}</span>}</div>
          {!!issues.length && <div className="ns-summary" role="alert" tabIndex={-1} ref={summary}><h3>{t('validationTitle')}</h3><ul>{issues.map((issue: ConfigIssue, index: number) => <li key={`${issue.path}-${index}`}><a href={`#${fieldId(issue.path)}`} onClick={(event: any) => { event.preventDefault(); focusPath(issue.path); }}>{label(issue.path)} <code>{issue.path}</code> — {t('invalidField')}</a></li>)}</ul></div>}
          {snapshot && !snapshot.active.isSelf && <div className="ns-blockers ns-blockers--info" role="status"><h3>{t('activeTitle')}</h3><p>{tr('activeOther', { provider: snapshot.active.searchProvider || t('notSpecified') })}</p><button type="button" disabled={!!pending} onClick={() => action('activate')}>{t('activateSelf')}</button></div>}
          {!!blockers.length && <div className="ns-blockers" role="status" aria-live="polite"><h3>{t('blockersTitle')}</h3><ul>{blockers.map(blocker => <li key={blocker.key}>{tr(blocker.key, blocker.vars)} <button type="button" className="ns-link" onClick={() => focusPath(blocker.jump)}>{t('fixIt')}</button></li>)}</ul></div>}
          {!snapshot ? <button disabled={!!pending} onClick={async () => { setPending('load'); try { const next = await refresh(); setDraft(clone(next.config)); setNotice(''); setFailed(false); } catch { setFailed(true); setNotice('loadFailed'); } finally { setPending(''); } }}>{t('reload')}</button> : <>
          <div className="ns-tabs" role="tablist" aria-label={t('tabsLabel')}>
            {TABS.map(id => <button key={id} role="tab" type="button" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} className={`ns-tab ${tab === id ? 'is-active' : ''}`} onClick={() => setTab(id)}>{t(`tab.${id}`)}{id === 'backends' && <span className="ns-tab-count">{enabledCount}/{definitions.length}</span>}</button>)}
          </div>
          {tab === 'behavior' && <div role="tabpanel" id="panel-behavior" aria-labelledby="tab-behavior">
            <section className="ns-card" aria-labelledby="sec-behavior"><h3 id="sec-behavior">{t('general')}</h3><div className="ns-grid">{fields(['mode', 'singleBackend', 'maxResults', 'concurrency', 'overallTimeoutMs', 'language', 'region', 'recency', 'safeSearch', 'includeDomains', 'excludeDomains', 'dedup', 'fusion', 'tools.webSearchPlus'], { 'tools.webSearchPlus': { type: 'checkbox' }, mode: { choices: ['single', 'parallel'] }, singleBackend: { choices: definitions.map(def => def.id) }, maxResults: { type: 'number' }, concurrency: { type: 'number' }, overallTimeoutMs: { type: 'number' }, language: { choices: [...LANGUAGES] }, region: { choices: [...REGIONS] }, recency: { choices: ['any', 'day', 'week', 'month', 'year'] }, safeSearch: { type: 'checkbox' }, includeDomains: { type: 'list' }, excludeDomains: { type: 'list' }, dedup: { choices: ['url', 'url-title'] }, fusion: { choices: ['rrf', 'ordered'] } })}</div></section>
          </div>}
          {tab === 'reliability' && <div role="tabpanel" id="panel-reliability" aria-labelledby="tab-reliability">
            {section('resilience', ['sec-resilience'], ['retry.enabled', 'retry.maxRetries', 'retry.initialDelayMs', 'retry.maxDelayMs', 'retry.networkErrors', 'retry.timeouts', 'breaker.enabled', 'breaker.threshold', 'breaker.cooldownMs'], { 'retry.enabled': { type: 'checkbox' }, 'retry.maxRetries': { type: 'number' }, 'retry.initialDelayMs': { type: 'number' }, 'retry.maxDelayMs': { type: 'number' }, 'retry.networkErrors': { type: 'checkbox' }, 'retry.timeouts': { type: 'checkbox' }, 'breaker.enabled': { type: 'checkbox' }, 'breaker.threshold': { type: 'number' }, 'breaker.cooldownMs': { type: 'number' } })}
            {draft.retry.enabled && <section className="ns-card" aria-labelledby="sec-retry-statuses"><h3 id="sec-retry-statuses">{t('field.retry.statuses')}</h3><p className="ns-muted">{t('help.retry.statuses')}</p><div className="ns-statuses">{RETRY_STATUSES.map(code => <label key={code} className="ns-status-choice"><input type="checkbox" checked={draft.retry.statuses.includes(code)} disabled={!!pending} onChange={(event: any) => update('retry.statuses', event.target.checked ? [...draft.retry.statuses, code].sort((a, b) => a - b) : draft.retry.statuses.filter((item: number) => item !== code))} /><span>{code}</span></label>)}</div>{!!issues.filter((issue: ConfigIssue) => issue.path === 'retry.statuses').length && <p className="ns-error" role="alert">{t('invalidField')}</p>}</section>}
            {section('storage', ['sec-storage'], ['cache.enabled', 'cache.ttlSeconds', 'cache.maxEntries', 'diagnostics.enabled', 'diagnostics.maxEntries'], { 'cache.enabled': { type: 'checkbox' }, 'cache.ttlSeconds': { type: 'number' }, 'cache.maxEntries': { type: 'number' }, 'diagnostics.enabled': { type: 'checkbox' }, 'diagnostics.maxEntries': { type: 'number' } })}
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
                  const mode = def.modes.find(item => item.mode === backend.mode); const base = `backends.${def.id}`; const credentialState = snapshot.credentials[def.id]; const locked = def.status !== 'documented'; const anonymous = backend.mode === 'anonymous';
                  return <details className="ns-card ns-backend" key={def.id}><summary><span className="ns-backend-title">{def.title}</span><span className="ns-chips">{def.modes.map(item => <span key={item.mode} className={`ns-chip ${item.mode === backend.mode ? 'is-on' : ''} ${item.tier === 'unverified' ? 'ns-chip--off' : tierRisk(item.tier)}`} aria-current={item.mode === backend.mode ? 'true' : undefined} title={t(`choice.${item.mode}`)}>{t(`choice.${item.mode}`)} · {t(`tier.${item.tier}`)}</span>)}{locked && <span className="ns-chip ns-chip--off">{t('unverified')}</span>}<span className={`ns-dot ${credentialState?.configured ? 'is-on' : 'is-off'}`} aria-hidden="true" /><span className={`ns-badge ${backend.enabled ? 'is-on' : ''}`}>{backend.enabled ? t('enabled') : t('disabled')}</span></span></summary>
                    <div className="ns-backend-body">
                      {locked && <p className="ns-warning">{t('unverifiedHelp')}</p>}
                      <p className="ns-quota">{mode?.limits[lang]} <a href={mode?.pricingUrl || def.docs} target="_blank" rel="noreferrer">{t('source')}</a> · {t('verifiedAt')} {def.verifiedAt || t('notVerified')}</p>
                      <div className="ns-grid">{fields([`${base}.enabled`, `${base}.mode`, `${base}.endpoint`, `${base}.credentialRef`, `${base}.timeoutMs`, `${base}.rateLimitPerMinute`, `${base}.dailyAttemptLimit`], { [`${base}.enabled`]: { type: 'checkbox', disabled: locked }, [`${base}.mode`]: { choices: def.modes.map(item => item.mode), disabled: locked }, [`${base}.timeoutMs`]: { type: 'number' }, [`${base}.rateLimitPerMinute`]: { type: 'number' }, [`${base}.dailyAttemptLimit`]: { type: 'number' } }).filter(node => !(anonymous && node.key === `${base}.credentialRef`))}</div>
                      {anonymous && !locked && <p className="ns-muted">{t('anonymousNoCredential')}</p>}
                      {def.options.length > 0 && <details className="ns-advanced"><summary>{t('advancedOptions')}</summary><div className="ns-grid">{def.options.map(option => field(`${base}.options.${option.key}`, { type: option.type === 'boolean' ? 'checkbox' : option.type === 'number' ? 'number' : 'text', choices: option.choices, help: option.help[lang], customLabel: option.label[lang], disabled: locked, min: option.min, max: option.max }))}</div></details>}
                      {!anonymous && !locked && <div className="ns-credential"><h5>{t('credentialTitle')}</h5><p>{t(credentialState?.configured ? 'credentialConfigured' : 'credentialMissing')} · {t('credentialHelp')}</p>{<p className="ns-credential-shape" aria-label={t('credentialShapeLabel')}><code>{mode?.credentialShape?.[lang] ?? t('credentialPlainKey')}</code></p>}<label htmlFor={`secret-${def.id}`}>{t('credentialValue')}</label><input id={`secret-${def.id}`} type="password" autoComplete="new-password" aria-describedby={`secret-${def.id}-why`} value={secrets[def.id] || ''} disabled={credentialDisabled(def.id)} onChange={(event: any) => setSecrets((previous: Record<string, string>) => ({ ...previous, [def.id]: event.target.value }))} />{credentialDisabledReason(def.id) && <small id={`secret-${def.id}-why`} className="ns-warning">{credentialDisabledReason(def.id)}</small>}<div className="ns-actions"><button disabled={credentialDisabled(def.id) || !secrets[def.id]} onClick={() => credential(def.id, false)}>{t('replaceCredential')}</button><button disabled={credentialDisabled(def.id) || !credentialState?.configured} onClick={() => setConfirming({ kind: `delete-credential-${def.id}`, backendId: def.id })}>{t('deleteCredential')}</button></div>{confirmRow(`delete-credential-${def.id}`, 'deleteCredentialConfirm', () => { void credential(def.id, true); })}</div>}
                      <p className="ns-meta"><span>{t('attemptsToday')} <strong>{snapshot.counters[def.id]?.attempts ?? 0}</strong></span><span aria-hidden="true">·</span><span>{snapshot.counters[def.id]?.day ?? t('noData')}</span></p>
                    </div>
                  </details>;
              })}
              {!definitions.some(matches) && <p className="ns-muted">{t('noMatch')}</p>}
            </section>
          </div>}
          <footer className="ns-footer"><span aria-live="polite">{dirty ? tr('unsavedWithErrors', { errors: issues.length }) : t('upToDate')}</span><div className="ns-actions"><button disabled={!!pending || !dirty} onClick={() => setConfirming({ kind: 'discard' })}>{t('discard')}</button><button className="ns-primary" disabled={!!pending || !dirty} onClick={save}>{t(pending === 'save' ? 'saving' : 'save')}</button></div>{confirmRow('discard', 'discardConfirm', () => { setDraft(clone(snapshot.config)); setIssues([]); setNotice(''); })}</footer>
          </>}
        </div>;
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'nite-search', order: 16, label: () => t('title') }, Page));
    },
  };
}
