import { catalog } from './catalog.js';
import { LANGUAGES, REGIONS } from './locale-map.js';
import { DEFAULT_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS, MIN_MAX_CONCURRENT_READS } from './browser-limits.js';
import { DEFAULT_FALLBACK_RULES, validateRules } from './fetch/rules.js';
import {
  DEFAULT_FETCH_OVERALL_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RULE_SCAN_CHARS,
  DEFAULT_ROUTE_TIMEOUT_MS,
  FETCH_BROWSER_CONTEXT_MODES,
  FETCH_ROUTE_KINDS,
  MAX_BROWSER_SETTLE_MS,
  MAX_FETCH_BODY_BYTES,
  MAX_FETCH_OUTPUT_CHARS,
  MAX_FETCH_OVERALL_TIMEOUT_MS,
  MAX_RULE_SCAN_CHARS,
  MAX_FETCH_REDIRECTS,
  MAX_ROUTE_TIMEOUT_MS,
  MAX_SELECTOR_LENGTH,
  MIN_FETCH_BODY_BYTES,
  MIN_FETCH_OUTPUT_CHARS,
  MIN_FETCH_OVERALL_TIMEOUT_MS,
  MIN_ROUTE_TIMEOUT_MS,
} from './fetch/limits.js';
import type { BackendDefinition, ConfigIssue, SearchConfig } from './types.js';
import type { FetchBackendConfig, FetchRouteConfig, PageFetchConfig } from './fetch/types.js';
/**
 * The credential name this library files a backend's key under. It is fixed here and not part of the
 * configuration on purpose: a saved row must not be able to point a lookup at another name, and the
 * settings page never has to show or ask for a name.
 */
export function backendCredentialRef(id: string): string {
  return `DSH_SEARCH_${id.replaceAll('-', '_').toUpperCase()}_KEY`;
}
/** The single endpoint token every browser-backed reader uses. Fixed for the same reason. */
export function browserCredentialRef(): string {
  return 'DSH_SEARCH_BROWSER_TOKEN';
}

/** One record per route kind, in the default order; only the HTTP route starts enabled. */
export function defaultFetchRoutes(): FetchRouteConfig[] {
  return (['http', 'browser', 'provider'] as const).map(kind => ({
    kind,
    enabled: kind === 'http',
    timeoutMs: DEFAULT_ROUTE_TIMEOUT_MS[kind],
    rules: structuredClone(DEFAULT_FALLBACK_RULES),
  }));
}

export function defaultPageFetchConfig(): PageFetchConfig {
  return {
    routes: defaultFetchRoutes(),
    providerId: '',
    overallTimeoutMs: DEFAULT_FETCH_OVERALL_TIMEOUT_MS,
    maxRedirects: DEFAULT_MAX_REDIRECTS,
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    maxRuleScanChars: DEFAULT_MAX_RULE_SCAN_CHARS,
    allowPrivateNetworks: false,
    allowDelegatedFetching: false,
    browser: { context: 'isolated', settleMs: 0, selectorWait: '' },
  };
}

/**
 * Fetch settings are per operation, not per provider: the verified fetch endpoint is the one the
 * operation was observed on, and a provider without a fetch operation keeps an inert record so saved
 * search rows stay shaped the same way.
 */
export function defaultFetchBackendConfig(definition: BackendDefinition): FetchBackendConfig {
  const mode = definition.fetch?.modes[0] ?? definition.modes[0]!.mode;
  const endpoint = definition.fetch ? (definition.modes.find(item => item.mode === mode)?.fetchEndpoint ?? '') : '';
  return {
    mode,
    endpoint,
    timeoutMs: DEFAULT_ROUTE_TIMEOUT_MS.provider,
    options: Object.fromEntries((definition.fetch?.options ?? []).map(option => [option.key, option.default])),
  };
}

export function defaultConfig(): SearchConfig {
  return {
    maxResults:8, concurrency:4, overallTimeoutMs:30000,
    language:'', region:'', recency:'any', safeSearch:true, includeDomains:[], excludeDomains:[],dedup:'url',fusion:'rrf',
    browser:{endpoint:'',statePath:'',timeoutMs:60000,maxConcurrentReads:DEFAULT_MAX_CONCURRENT_READS},
    retry:{enabled:true,statuses:[408,429,500,502,503,504],maxRetries:2,initialDelayMs:500,maxDelayMs:5000,networkErrors:false,timeouts:false},
    cache:{enabled:true,ttlSeconds:900,maxEntries:100},breaker:{enabled:false,threshold:3,cooldownMs:60000},diagnostics:{enabled:true,maxEntries:50},tools:{webSearchPlus:true,compactByDefault:false,webExtract:false},
    pageFetch:defaultPageFetchConfig(),
    backends:Object.fromEntries(catalog.map(d=>[d.id,{enabled:false,mode:d.modes[0]!.mode,endpoint:d.modes[0]!.endpoint,timeoutMs:15000,rateLimitPerMinute:0,dailyAttemptLimit:0,options:Object.fromEntries(d.options.map(o=>[o.key,o.default])),fetch:defaultFetchBackendConfig(d)}]))
  };
}
export function validateConfig(value: unknown): ConfigIssue[] {
  const issues: ConfigIssue[]=[];
  const fail=(path:string,message:string)=>issues.push({path,message});
  const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  if(!object(value))return [{path:'config',message:'Expected a configuration object.'}];
  function shape(v:unknown, exemplar:unknown,path:string){
    if(Array.isArray(exemplar)){
      if(!Array.isArray(v)){fail(path,'Expected an array.');return;}
      if(v.length>200)fail(path,'Too many entries.');
      if(path==='retry.statuses'){if(v.some(n=>!Number.isInteger(n)||n<400||n>599))fail(path,'Expected HTTP error status codes (400–599).');}
      // Only the two domain lists are domain-shaped; page-fetch arrays hold records and are checked below.
      else if(path==='includeDomains'||path==='excludeDomains'){if(v.some(x=>typeof x!=='string'||x.length>253||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(x)))fail(path,'Expected domain names without scheme, path, or wildcards.');}
    }else if(object(exemplar)){
      if(!object(v)){fail(path,'Expected an object.');return;}
      // Retired backends may still sit in a saved row; they are pruned on load, not rejected.
      for(const k of Object.keys(v))if(!(k in exemplar)&&path!=='backends')fail(path?`${path}.${k}`:k,'Unknown configuration field.');
      for(const [k,e]of Object.entries(exemplar))shape(v[k],e,path?`${path}.${k}`:k);
    }else if(typeof v!==typeof exemplar|| (typeof v==='number'&&!Number.isFinite(v)))fail(path,`Expected ${typeof exemplar}.`);
    else if(typeof v==='string'&&v.length>4096)fail(path,'Value is too long.');
  }
  shape(value,defaultConfig(),'');
  if(issues.length)return issues;
  const c=value as unknown as SearchConfig;
  const choice=(v:string,allowed:string[],p:string)=>{if(!allowed.includes(v))fail(p,'Unsupported selection.');};
  const num=(v:number,min:number,max:number,p:string)=>{if(!Number.isInteger(v)||v<min||v>max)fail(p,`Expected an integer between ${min} and ${max}.`);};
  if(c.language&&!(LANGUAGES as readonly string[]).includes(c.language))fail('language','Unsupported language code.');
  if(c.region&&!(REGIONS as readonly string[]).includes(c.region))fail('region','Unsupported region code.');
  choice(c.recency,['any','day','week','month','year'],'recency');choice(c.dedup,['url','url-title'],'dedup');choice(c.fusion,['rrf','ordered'],'fusion');
  num(c.maxResults,1,50,'maxResults');num(c.concurrency,1,20,'concurrency');num(c.overallTimeoutMs,1000,180000,'overallTimeoutMs');
  num(c.retry.maxRetries,0,5,'retry.maxRetries');num(c.retry.initialDelayMs,0,60000,'retry.initialDelayMs');num(c.retry.maxDelayMs,0,120000,'retry.maxDelayMs');
  if(c.retry.initialDelayMs>c.retry.maxDelayMs)fail('retry.maxDelayMs','Maximum delay must not be shorter than initial delay.');
  num(c.cache.ttlSeconds,1,86400,'cache.ttlSeconds');num(c.cache.maxEntries,1,1000,'cache.maxEntries');num(c.breaker.threshold,1,100,'breaker.threshold');num(c.breaker.cooldownMs,1000,3600000,'breaker.cooldownMs');num(c.diagnostics.maxEntries,1,500,'diagnostics.maxEntries');
  // An endpoint is an HTTP URL, except for browser backends, which point at a Playwright server (a
  // WebSocket URL); the scheme family has to match the kind, and both accept TLS. The host itself is
  // not gated: an operator may run a search server or a browser container behind any name, including
  // the container-runtime aliases (host.containers.internal, host.docker.internal), so plaintext is
  // allowed wherever the operator points it.
  const checkEndpoint=(endpoint:string,path:string)=>{try{
      const url=new URL(endpoint);if(url.username||url.password||url.hash||url.search)throw 0;
      const schemes=url.protocol==='ws:'||url.protocol==='wss:'?['ws:','wss:']:['http:','https:'];
      if(!schemes.includes(url.protocol))throw 0;
    }catch{fail(path,'Use an HTTP(S) or WS(S) endpoint without credentials, query, or fragment.');}};
  const sharedBrowser=c.browser.endpoint;
  if(sharedBrowser)checkEndpoint(sharedBrowser,'browser.endpoint');
  if(!(c.browser.timeoutMs>=1000&&c.browser.timeoutMs<=120000))fail('browser.timeoutMs','Expected 1000 to 120000 milliseconds.');
  num(c.browser.maxConcurrentReads,MIN_MAX_CONCURRENT_READS,MAX_CONCURRENT_READS,'browser.maxConcurrentReads');
  for(const d of catalog){const b=c.backends[d.id]!;const p=`backends.${d.id}`;
    choice(b.mode,d.modes.map(m=>m.mode),`${p}.mode`);
    if(b.enabled&&d.status==='unverified')fail(`${p}.enabled`,'Backend protocol is not verified.');
    if(b.endpoint)checkEndpoint(b.endpoint,`${p}.endpoint`);
    // A browser backend may inherit the shared endpoint instead of naming its own.
    else if(b.enabled&&!(b.mode==='browser'&&sharedBrowser))fail(`${p}.endpoint`,'An endpoint is required.');
    num(b.timeoutMs,1000,120000,`${p}.timeoutMs`);num(b.rateLimitPerMinute,0,100000,`${p}.rateLimitPerMinute`);num(b.dailyAttemptLimit,0,1000000,`${p}.dailyAttemptLimit`);
    for(const o of d.options){const v=b.options[o.key];if(o.choices&&!o.choices.includes(String(v)))fail(`${p}.options.${o.key}`,'Unsupported option.');if(typeof v==='number')num(v,o.min??1,o.max??100000,`${p}.options.${o.key}`);}
    // Fetch settings live on the same record as the search settings, but are validated separately:
    // a provider that has no verified fetch operation cannot smuggle one in through the file.
    const fetch = b.fetch;
    if (d.fetch) {
      choice(fetch.mode, d.fetch.modes, `${p}.fetch.mode`);
      if (fetch.endpoint) checkHttpEndpoint(fetch.endpoint, `${p}.fetch.endpoint`, fail);
      num(fetch.timeoutMs, MIN_ROUTE_TIMEOUT_MS, MAX_ROUTE_TIMEOUT_MS, `${p}.fetch.timeoutMs`);
      for (const option of d.fetch.options) {
        const v = fetch.options[option.key];
        if (option.choices && !option.choices.includes(String(v))) fail(`${p}.fetch.options.${option.key}`, 'Unsupported option.');
        if (typeof v === 'number') num(v, option.min ?? 1, option.max ?? 1_000_000, `${p}.fetch.options.${option.key}`);
        if (typeof v === 'boolean' && typeof v !== 'boolean') fail(`${p}.fetch.options.${option.key}`, 'Expected a boolean.');
      }
    } else {
      choice(fetch.mode, d.modes.map(m => m.mode), `${p}.fetch.mode`);
      if (fetch.endpoint) fail(`${p}.fetch.endpoint`, 'This provider has no fetch endpoint.');
      num(fetch.timeoutMs, MIN_ROUTE_TIMEOUT_MS, MAX_ROUTE_TIMEOUT_MS, `${p}.fetch.timeoutMs`);
    }
  }
  validatePageFetch(c, fail);
  return issues;
}

/** Fetch endpoints are MCP or HTTP(S) endpoints; a WebSocket URL makes no sense for a page fetch. */
function checkHttpEndpoint(endpoint: string, path: string, fail: (path: string, message: string) => void): void {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash) throw 0;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw 0;
  } catch {
    fail(path, 'Use an HTTP(S) endpoint without credentials or fragment.');
  }
}

/** Page-fetch validation: route set, rule language, provider readiness and the safety switches. */
function validatePageFetch(c: SearchConfig, fail: (path: string, message: string) => void): void {
  const page = c.pageFetch;
  if (!Array.isArray(page.routes)) {
    fail('pageFetch.routes', 'Expected the three route records.');
    return;
  }
  // A hand-edited file can put null or a primitive where a route belongs. Report that as a path,
  // never as a TypeError from reading `.kind` off it.
  if (page.routes.some(route => !route || typeof route !== 'object' || Array.isArray(route))) {
    fail('pageFetch.routes', 'Each route must be an object with kind, enabled, timeoutMs and rules.');
    return;
  }
  const kinds = page.routes.map(route => route.kind);
  if (page.routes.length !== FETCH_ROUTE_KINDS.length || new Set(kinds).size !== page.routes.length || FETCH_ROUTE_KINDS.some(kind => !kinds.includes(kind))) {
    fail('pageFetch.routes', 'Hold exactly one record of each route: http, browser, provider.');
  }
  const num = (value: number, min: number, max: number, path: string): void => {
    if (!Number.isInteger(value) || value < min || value > max) fail(path, `Expected an integer between ${min} and ${max}.`);
  };
  page.routes.forEach((route, index) => {
    const path = `pageFetch.routes.${index}`;
    if (typeof route.enabled !== 'boolean') fail(`${path}.enabled`, 'Expected a boolean.');
    num(route.timeoutMs, MIN_ROUTE_TIMEOUT_MS, MAX_ROUTE_TIMEOUT_MS, `${path}.timeoutMs`);
    for (const issue of validateRules(route.rules, route.kind, `${path}.rules`)) {
      const separator = issue.indexOf(': ');
      if (separator > 0) fail(issue.slice(0, separator), issue.slice(separator + 2));
      else fail(path, issue);
    }
    if (route.kind === 'browser' && route.enabled && !c.browser.endpoint) {
      fail(`${path}.enabled`, 'The browser route needs a shared browser endpoint before it can be enabled.');
    }
    if ((route.kind === 'browser' || route.kind === 'provider') && route.enabled && !page.allowDelegatedFetching) {
      fail(
        `${path}.enabled`,
        'A browser or provider route resolves the target outside this process, so the public-only check cannot prove its destination. Enable allowDelegatedFetching deliberately to use it.',
      );
    }
  });
  const enabled = page.routes.filter(route => route.enabled);
  if (!enabled.length) fail('pageFetch.routes', 'At least one route has to be enabled.');
  if (typeof page.allowPrivateNetworks !== 'boolean') fail('pageFetch.allowPrivateNetworks', 'Expected a boolean.');
  if (typeof page.allowDelegatedFetching !== 'boolean') fail('pageFetch.allowDelegatedFetching', 'Expected a boolean.');
  num(page.overallTimeoutMs, MIN_FETCH_OVERALL_TIMEOUT_MS, MAX_FETCH_OVERALL_TIMEOUT_MS, 'pageFetch.overallTimeoutMs');
  num(page.maxRedirects, 0, MAX_FETCH_REDIRECTS, 'pageFetch.maxRedirects');
  if (!Number.isInteger(page.maxBodyBytes) || page.maxBodyBytes < MIN_FETCH_BODY_BYTES || page.maxBodyBytes > MAX_FETCH_BODY_BYTES) {
    fail('pageFetch.maxBodyBytes', `Expected an integer between ${MIN_FETCH_BODY_BYTES} and ${MAX_FETCH_BODY_BYTES}.`);
  }
  num(page.maxOutputChars, MIN_FETCH_OUTPUT_CHARS, MAX_FETCH_OUTPUT_CHARS, 'pageFetch.maxOutputChars');
  num(page.maxRuleScanChars, MIN_FETCH_OUTPUT_CHARS, MAX_RULE_SCAN_CHARS, 'pageFetch.maxRuleScanChars');
  if (!(FETCH_BROWSER_CONTEXT_MODES as readonly string[]).includes(page.browser.context)) fail('pageFetch.browser.context', 'Unsupported selection.');
  num(page.browser.settleMs, 0, MAX_BROWSER_SETTLE_MS, 'pageFetch.browser.settleMs');
  if (page.browser.selectorWait.length > MAX_SELECTOR_LENGTH) fail('pageFetch.browser.selectorWait', `At most ${MAX_SELECTOR_LENGTH} characters.`);

  const selected = page.providerId;
  if (typeof selected !== 'string') {
    fail('pageFetch.providerId', 'Expected a provider id or an empty string.');
    return;
  }
  const providerRoute = page.routes.find(route => route.kind === 'provider');
  const providerDefinition = selected ? catalog.find(item => item.id === selected) : undefined;
  if (selected && (!providerDefinition || !providerDefinition.fetch)) {
    fail('pageFetch.providerId', 'The selected provider is not fetch-capable in this release.');
    return;
  }
  if (providerRoute?.enabled) {
    if (!selected || !providerDefinition?.fetch) {
      fail('pageFetch.providerId', 'The provider route needs a selected fetch-capable provider.');
      return;
    }
    const operation = providerDefinition.fetch;
    const saved = c.backends[providerDefinition.id];
    if (!saved) {
      fail('pageFetch.providerId', 'The selected provider has no saved configuration record.');
      return;
    }
    if (!operation.modes.includes(saved.fetch.mode)) {
      fail(`backends.${providerDefinition.id}.fetch.mode`, `This provider does not fetch in ${saved.fetch.mode} mode.`);
    }
    const endpoint = saved.fetch.endpoint || providerDefinition.modes.find(mode => mode.mode === saved.fetch.mode)?.fetchEndpoint;
    if (!endpoint) fail(`backends.${providerDefinition.id}.fetch.endpoint`, 'A fetch endpoint is required for the selected provider.');
  } else if (selected && providerDefinition?.fetch) {
    // Selecting a provider without the route enabled is allowed, but a broken fetch mode is still a
    // saved value the user should hear about rather than a surprise on the next enable.
    const operation = providerDefinition.fetch;
    const saved = c.backends[providerDefinition.id];
    if (saved && !operation.modes.includes(saved.fetch.mode)) {
      fail(`backends.${providerDefinition.id}.fetch.mode`, `This provider does not fetch in ${saved.fetch.mode} mode.`);
    }
  }
}

/**
 * Fill only what is missing. A saved value is never rewritten: an explicit null, a wrong type or an
 * out-of-range number stays exactly as saved and is then rejected by validation.
 */
function fillMissing(target: unknown, exemplar: unknown): void {
  if (!exemplar || typeof exemplar !== 'object' || Array.isArray(exemplar)) return;
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const record = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(exemplar as Record<string, unknown>)) {
    if (!Object.hasOwn(record, key)) {
      record[key] = structuredClone(value);
      continue;
    }
    fillMissing(record[key], value);
  }
}

export function parseConfig(value:unknown):SearchConfig{
  const defaults=defaultConfig();
  // Migrations run on a copy: the caller's object is never mutated.
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    const raw=structuredClone(value) as any;
    // Migrate the backend map before validation: drop entries this release no longer ships, add ones it now ships.
    if(raw.backends&&typeof raw.backends==='object'){
      for(const id of Object.keys(raw.backends))if(!(id in defaults.backends))delete raw.backends[id];
      for(const [id,fallback] of Object.entries(defaults.backends))if(!raw.backends[id])raw.backends[id]=fallback;
      // A credential reference used to be a configuration field. The name is fixed in code now, so a
      // saved reference is dropped instead of being honoured: nothing in a file may redirect a lookup.
      if(raw.browser&&typeof raw.browser==='object')delete raw.browser.credentialRef;
      for(const id of Object.keys(raw.backends)){const row=raw.backends[id];if(row&&typeof row==='object')delete row.credentialRef;}
    }
    // A browser block saved before the per-site read cap existed gets the default. Only a missing key
    // is filled: an explicit null, wrong type or out-of-range value is left for validation to reject,
    // and unknown sibling keys stay unknown.
    if(raw.browser&&typeof raw.browser==='object'&&!Array.isArray(raw.browser)&&!Object.hasOwn(raw.browser,'maxConcurrentReads'))raw.browser.maxConcurrentReads=defaults.browser.maxConcurrentReads;
    // How many backends a search runs is decided by the call, not by a saved mode: `mode` and
    // `singleBackend` are retired fields, dropped on load instead of failing the whole file.
    delete raw.mode;delete raw.singleBackend;
    // Fetch fields arrived after search fields: a configuration saved by an older release gets the
    // page-fetch block and the per-provider fetch settings added, and nothing else is touched.
    fillMissing(raw, defaults);
    value=raw;
  }
  const issues=validateConfig(value);
  if(issues.length)throw new Error(issues.map(x=>`${x.path}: ${x.message}`).join('\n'));
  return structuredClone(value) as SearchConfig;
}
