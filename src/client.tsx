import styles from './client.css';
import en from '../locale/en.json';
import zh from '../locale/zh.json';
import { defaultConfig, validateConfig } from './config';
import { catalog } from './catalog';
import type { BackendDefinition, BackendOutcome, ConfigIssue, SearchConfig, SettingsSnapshot } from './types';

const API = '/api/nite-search';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const ranges: Record<string, [number, number]> = { maxResults: [1, 50], concurrency: [1, 20], overallTimeoutMs: [1000, 180000], 'retry.maxRetries': [0, 5], 'retry.initialDelayMs': [0, 60000], 'retry.maxDelayMs': [0, 120000], 'cache.ttlSeconds': [1, 86400], 'cache.maxEntries': [1, 1000], 'breaker.threshold': [1, 100], 'breaker.cooldownMs': [1000, 3600000], 'diagnostics.maxEntries': [1, 500], 'backend.timeoutMs': [1000, 120000], 'backend.rateLimitPerMinute': [0, 100000], 'backend.dailyAttemptLimit': [0, 1000000] };
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
      function Page({ close }: { close: () => void }) {
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
        const summary = React.useRef(null as HTMLDivElement | null);
        const dirty = !!snapshot && !same(draft, snapshot.config);
        const definitions: BackendDefinition[] = snapshot?.catalog || catalog;
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
        function field(path: string, type = 'text', choices?: string[], help?: string, customLabel?: string, disabled = false, min?: number, max?: number) {
          const value = get(draft, path); const id = fieldId(path); const errors = issues.filter((issue: ConfigIssue) => issue.path === path);
          const range = ranges[path.replace(/^backends\.[^.]+\./, 'backend.')];
          min ??= range?.[0]; max ??= range?.[1];
          const props = { id, disabled: !!pending || disabled, 'aria-invalid': errors.length > 0, 'aria-describedby': `${id}-help${errors.length ? ` ${id}-error` : ''}` };
          return <div className={`ns-field ${type === 'checkbox' ? 'ns-check' : ''}`} key={path}>
            <label htmlFor={id}>{customLabel || label(path)}</label>
            {type === 'checkbox' ? <input {...props} type="checkbox" checked={!!value} onChange={(event: any) => update(path, event.target.checked)} /> : choices ? <select {...props} value={value} onChange={(event: any) => update(path, event.target.value)}>{choices.map(choice => <option key={choice} value={choice}>{path === 'singleBackend' ? definitions.find(def => def.id === choice)?.title || choice : path.includes('.options.') ? choice : t(`choice.${choice}`)}</option>)}</select> : type === 'list' || type === 'numbers' ? <ListInput {...props} value={value} numeric={type === 'numbers'} onCommit={(next: unknown) => update(path, next)} /> : <input {...props} type={type} min={min} max={max} value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(event: any) => { const raw = event.target.value; update(path, type === 'number' ? (raw === '' ? '' : Number(raw)) : type === 'list' ? raw.split(',').map((part: string) => part.trim()).filter(Boolean) : type === 'numbers' ? raw.split(',').map((part: string) => Number(part.trim())).filter((n: number) => Number.isFinite(n)) : raw); }} />}
            <small id={`${id}-help`}>{help || t(`help.${path.replace(/^backends\.[^.]+\./, 'backend.')}`)}{type === 'number' && min !== undefined && max !== undefined ? ` (${min}–${max})` : ''}</small>
            {!!errors.length && <small className="ns-error" id={`${id}-error`}>{t('invalidField')}</small>}
          </div>;
        }
        function section(title: string, fields: any[]) { return <section className="ns-card"><h3>{t(title)}</h3><div className="ns-grid">{fields}</div></section>; }
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
          if (!snapshot || dirty) return; const backend = snapshot.config.backends[id];
          setPending(`credential-${id}`); setFailed(false); setNotice('working');
          try { await request('credential', { backendId: id, ref: backend.credentialRef, ...(remove ? { remove: true } : { value: secrets[id] }) }); setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); await refresh(); setNotice('credentialSaved'); }
          catch { setSecrets((previous: Record<string, string>) => ({ ...previous, [id]: '' })); setFailed(true); setNotice('credentialFailed'); } finally { setPending(''); }
        }
        function importConfig() {
          try { const parsed = JSON.parse(importText); const errors = validateConfig(parsed); setIssues(errors); if (errors.length) return; setDraft(clone(parsed)); setImportText(''); setNotice('imported'); setFailed(false); }
          catch { setNotice('importFailed'); setFailed(true); }
        }
        function exportConfig() {
          const blob = new Blob([JSON.stringify(redact(draft), null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'nite-search.redacted.json'; link.click(); URL.revokeObjectURL(url);
        }
        function leave() { if (!dirty || window.confirm(t('discardConfirm'))) close(); }
        const enabledSaved = definitions.filter(def => def.status === 'documented' && snapshot?.config.backends[def.id]?.enabled);
        return <div className="ns-page" aria-busy={!!pending}>
          <style>{styles}</style>
          <header className="ns-header"><div><p className="ns-eyebrow">{t('eyebrow')}</p><h2>{t('title')}</h2><p>{t('intro')}</p></div><button type="button" onClick={leave}>{t('close')}</button></header>
          <div className="ns-status" role="status" aria-live="polite"><span className={failed ? 'ns-error' : ''}>{notice ? t(notice) : !snapshot ? t('loading') : dirty ? t('unsaved') : t('upToDate')}</span>{!!pending && <span>{t('pending')}</span>}</div>
          {!!issues.length && <div className="ns-summary" role="alert" tabIndex={-1} ref={summary}><h3>{t('validationTitle')}</h3><ul>{issues.map((issue: ConfigIssue, index: number) => <li key={`${issue.path}-${index}`}><a href={`#${fieldId(issue.path)}`} onClick={(event: any) => { event.preventDefault(); const target = document.getElementById(fieldId(issue.path)); const details = target?.closest('details'); if (details) details.open = true; target?.focus(); }}>{label(issue.path)} <code>{issue.path}</code> — {t('invalidField')}</a></li>)}</ul></div>}
          {!snapshot ? <button disabled={!!pending} onClick={async () => { setPending('load'); try { const next = await refresh(); setDraft(clone(next.config)); setNotice(''); setFailed(false); } catch { setFailed(true); setNotice('loadFailed'); } finally { setPending(''); } }}>{t('reload')}</button> : <>
          {section('general', [field('mode', 'text', ['single', 'parallel']), field('singleBackend', 'text', definitions.map(def => def.id)), field('maxResults', 'number'), field('concurrency', 'number'), field('overallTimeoutMs', 'number'), field('language'), field('region'), field('recency', 'text', ['any', 'day', 'week', 'month', 'year']), field('safeSearch', 'checkbox'), field('includeDomains', 'list'), field('excludeDomains', 'list'), field('dedup', 'text', ['url', 'url-title']), field('fusion', 'text', ['rrf', 'ordered'])])}
          <section className="ns-backends"><h3>{t('backends')}</h3><p className="ns-muted">{t('backendIntro')}</p>{(['free', 'allowance', 'trial', 'paid', 'self-hosted', 'unverified'] as const).map(tier => {
            const members = definitions.filter(def => (def.status === 'unverified' ? 'unverified' : def.modes.find(mode => mode.mode === draft.backends[def.id]?.mode)?.tier) === tier);
            return members.length ? <div className="ns-tier" key={tier}><h4>{t(`tier.${tier}`)}</h4>{members.map(def => {
              const backend = draft.backends[def.id]; if (!backend) return null;
              const mode = def.modes.find(item => item.mode === backend.mode); const base = `backends.${def.id}`; const credentialState = snapshot.credentials[def.id]; const locked = def.status !== 'documented';
              return <details className="ns-card ns-backend" key={def.id}><summary><span>{def.title}</span><span className="ns-badge">{locked ? t('unverified') : backend.enabled ? t('enabled') : t('disabled')}</span></summary>
                <div className="ns-backend-body">
                  {locked && <p className="ns-warning">{t('unverifiedHelp')}</p>}
                  <p className="ns-quota">{mode?.limits[lang]} <a href={mode?.pricingUrl || def.docs} target="_blank" rel="noreferrer">{t('source')}</a> · {t('verifiedAt')} {def.verifiedAt || t('notVerified')}</p>
                  <div className="ns-grid">{field(`${base}.enabled`, 'checkbox', undefined, undefined, undefined, locked)}{field(`${base}.mode`, 'text', def.modes.map(item => item.mode), undefined, undefined, locked)}{field(`${base}.endpoint`)}{field(`${base}.credentialRef`)}{field(`${base}.timeoutMs`, 'number')}{field(`${base}.rateLimitPerMinute`, 'number')}{field(`${base}.dailyAttemptLimit`, 'number')}{def.options.map(option => field(`${base}.options.${option.key}`, option.type === 'boolean' ? 'checkbox' : option.type === 'number' ? 'number' : 'text', option.choices, option.help[lang], option.label[lang], false, option.min, option.max))}</div>
                  <div className="ns-credential"><h5>{t('credentialTitle')}</h5><p>{t(credentialState?.configured ? 'credentialConfigured' : 'credentialMissing')} · {t('credentialHelp')}</p><label htmlFor={`secret-${def.id}`}>{t('credentialValue')}</label><input id={`secret-${def.id}`} type="password" autoComplete="new-password" value={secrets[def.id] || ''} disabled={!!pending || dirty || !credentialState?.writable || !backend.credentialRef || backend.mode !== 'key'} onChange={(event: any) => setSecrets((previous: Record<string, string>) => ({ ...previous, [def.id]: event.target.value }))} /><div className="ns-actions"><button disabled={!!pending || dirty || !credentialState?.writable || !secrets[def.id] || backend.mode !== 'key'} onClick={() => credential(def.id, false)}>{t('replaceCredential')}</button><button disabled={!!pending || dirty || !credentialState?.writable || !credentialState?.configured} onClick={() => { if (window.confirm(t('deleteCredentialConfirm'))) void credential(def.id, true); }}>{t('deleteCredential')}</button></div>{dirty && <small>{t('saveBeforeCredential')}</small>}</div>
                  <p className="ns-muted">{t('attemptsToday')}: {snapshot.counters[def.id]?.attempts ?? 0} · {snapshot.counters[def.id]?.day ?? t('noData')}</p>
                </div>
              </details>;
            })}</div> : null;
          })}</section>
          {section('resilience', [field('retry.enabled', 'checkbox'), field('retry.statuses', 'numbers'), field('retry.maxRetries', 'number'), field('retry.initialDelayMs', 'number'), field('retry.maxDelayMs', 'number'), field('retry.networkErrors', 'checkbox'), field('retry.timeouts', 'checkbox'), field('breaker.enabled', 'checkbox'), field('breaker.threshold', 'number'), field('breaker.cooldownMs', 'number')])}
          {section('storage', [field('cache.enabled', 'checkbox'), field('cache.ttlSeconds', 'number'), field('cache.maxEntries', 'number'), field('diagnostics.enabled', 'checkbox'), field('diagnostics.maxEntries', 'number')])}
          <section className="ns-card"><h3>{t('testTitle')}</h3><p>{t('testHelp')}</p><div className="ns-grid"><div className="ns-field"><label htmlFor="ns-test-backend">{t('testBackend')}</label><select id="ns-test-backend" disabled={!!pending || dirty} value={testBackend} onChange={(event: any) => setTestBackend(event.target.value)}><option value="">{t('chooseBackend')}</option>{enabledSaved.map(def => <option value={def.id} key={def.id}>{def.title}</option>)}</select></div><div className="ns-field"><label htmlFor="ns-test-query">{t('testQuery')}</label><input id="ns-test-query" value={query} disabled={!!pending || dirty} onChange={(event: any) => setQuery(event.target.value)} /></div></div><button disabled={!!pending || dirty || !query.trim() || !enabledSaved.some(def => def.id === testBackend)} onClick={() => action('test', { backendId: testBackend, query })}>{t('runTest')}</button>{testResult && <div className="ns-result"><h4>{t('testResult')}</h4><pre>{JSON.stringify(testResult, null, 2)}</pre></div>}</section>
          <section className="ns-card"><h3>{t('diagnosticsTitle')}</h3><p>{t('diagnosticsHelp')}</p><div className="ns-actions"><button disabled={!!pending} onClick={() => action('clear-cache')}>{t('clearCache')}</button><button disabled={!!pending} onClick={() => { if (window.confirm(t('clearDiagnosticsConfirm'))) void action('clear-diagnostics'); }}>{t('clearDiagnostics')}</button><button disabled={!!pending} onClick={async () => { setPending('refresh'); try { await refresh(); setNotice('done'); setFailed(false); } catch { setFailed(true); setNotice('actionFailed'); } finally { setPending(''); } }}>{t('refreshDiagnostics')}</button></div>{snapshot.diagnostics.length ? <div className="ns-table-wrap"><table><thead><tr>{['backend', 'mode', 'result', 'attempts', 'duration'].map(key => <th key={key}>{t(`diagnostic.${key}`)}</th>)}</tr></thead><tbody>{snapshot.diagnostics.map((item: BackendOutcome, index: number) => <tr key={index}><td>{item.backend}</td><td>{t(`choice.${item.mode}`)}</td><td className={item.ok ? 'ns-success' : 'ns-error'}>{item.ok ? t('ok') : t(`failure.${item.error?.kind || 'protocol'}`)}{item.warnings.length > 0 && <span> · {t('hasWarnings')}</span>}</td><td>{item.attempts}</td><td>{item.durationMs} {t('milliseconds')}</td></tr>)}</tbody></table></div> : <p className="ns-muted">{t('noDiagnostics')}</p>}</section>
          <section className="ns-card"><h3>{t('transferTitle')}</h3><p>{t('transferHelp')}</p><div className="ns-actions"><button disabled={!!pending} onClick={exportConfig}>{t('export')}</button><button disabled={!!pending} aria-expanded={showTransfer} onClick={() => setShowTransfer(!showTransfer)}>{t('import')}</button><button disabled={!!pending} onClick={() => { if (window.confirm(t('defaultsConfirm'))) { setDraft(clone(snapshot.defaults)); setIssues([]); setNotice('defaultsRestored'); } }}>{t('restoreDefaults')}</button></div>{showTransfer && <div className="ns-field"><label htmlFor="ns-import">{t('importLabel')}</label><textarea id="ns-import" value={importText} disabled={!!pending} onChange={(event: any) => setImportText(event.target.value)} rows={8} /><button disabled={!!pending || !importText.trim()} onClick={importConfig}>{t('applyImport')}</button></div>}</section>
          <footer className="ns-footer"><span>{t(dirty ? 'unsaved' : 'upToDate')}</span><div className="ns-actions"><button disabled={!!pending || !dirty} onClick={() => { if (window.confirm(t('discardConfirm'))) { setDraft(clone(snapshot.config)); setIssues([]); setNotice(''); } }}>{t('discard')}</button><button className="ns-primary" disabled={!!pending || !dirty} onClick={save}>{t(pending === 'save' ? 'saving' : 'save')}</button></div></footer>
          </>}
        </div>;
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'nite-search', order: 16, label: () => t('title') }, Page));
    },
  };
}
