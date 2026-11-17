import { catalog } from './catalog.js';
import { LANGUAGES, REGIONS } from './locale-map.js';
import type { ConfigIssue, SearchConfig } from './types.js';
/**
 * The reference name a release before the shared browser block generated for a backend's own
 * credential. It is kept only so a saved row can be recognised and migrated; nothing writes it now.
 */
export function legacyCredentialRef(id: string): string {
  return `DSH_SEARCH_${id.replaceAll('-', '_').toUpperCase()}_KEY`;
}
export function defaultConfig(): SearchConfig {
  return {
    mode:'parallel', singleBackend:'keenable', maxResults:8, concurrency:4, overallTimeoutMs:30000,
    language:'', region:'', recency:'any', safeSearch:true, includeDomains:[], excludeDomains:[],dedup:'url',fusion:'rrf',
    browser:{endpoint:'',credentialRef:'DSH_SEARCH_BROWSER_TOKEN',statePath:'',timeoutMs:60000},
    retry:{enabled:true,statuses:[408,429,500,502,503,504],maxRetries:2,initialDelayMs:500,maxDelayMs:5000,networkErrors:false,timeouts:false},
    cache:{enabled:true,ttlSeconds:900,maxEntries:100},breaker:{enabled:false,threshold:3,cooldownMs:60000},diagnostics:{enabled:true,maxEntries:50},tools:{webSearchPlus:true,compactByDefault:false},
    // A backend that only ever reads through the shared browser owns no credential of its own: the
    // endpoint token belongs to the browser, so the reference stays empty instead of borrowing a key name.
    backends:Object.fromEntries(catalog.map(d=>[d.id,{enabled:false,mode:d.modes[0]!.mode,endpoint:d.modes[0]!.endpoint,credentialRef:d.modes.some(m=>m.mode!=='browser')?legacyCredentialRef(d.id):'',timeoutMs:15000,rateLimitPerMinute:0,dailyAttemptLimit:0,options:Object.fromEntries(d.options.map(o=>[o.key,o.default]))}]))
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
      else if(v.some(x=>typeof x!=='string'||x.length>253||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(x)))fail(path,'Expected domain names without scheme, path, or wildcards.');
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
  choice(c.mode,['single','parallel'],'mode');choice(c.singleBackend,catalog.map(x=>x.id),'singleBackend');choice(c.recency,['any','day','week','month','year'],'recency');choice(c.dedup,['url','url-title'],'dedup');choice(c.fusion,['rrf','ordered'],'fusion');
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
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.browser.credentialRef))fail('browser.credentialRef','Expected an environment-style credential reference.');
  if(!(c.browser.timeoutMs>=1000&&c.browser.timeoutMs<=120000))fail('browser.timeoutMs','Expected 1000 to 120000 milliseconds.');
  for(const d of catalog){const b=c.backends[d.id]!;const p=`backends.${d.id}`;
    choice(b.mode,d.modes.map(m=>m.mode),`${p}.mode`);
    if(b.enabled&&d.status==='unverified')fail(`${p}.enabled`,'Backend protocol is not verified.');
    if(b.endpoint)checkEndpoint(b.endpoint,`${p}.endpoint`);
    // A browser backend may inherit the shared endpoint instead of naming its own.
    else if(b.enabled&&!(b.mode==='browser'&&sharedBrowser))fail(`${p}.endpoint`,'An endpoint is required.');
    // An empty reference is the normal state for a browser backend; a name is only kept for legacy
    // rows, where the token was stored per backend before the shared browser block existed.
    if((b.credentialRef!==''||b.mode!=='browser')&&!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.credentialRef))fail(`${p}.credentialRef`,'Expected an environment-style credential reference.');
    num(b.timeoutMs,1000,120000,`${p}.timeoutMs`);num(b.rateLimitPerMinute,0,100000,`${p}.rateLimitPerMinute`);num(b.dailyAttemptLimit,0,1000000,`${p}.dailyAttemptLimit`);
    for(const o of d.options){const v=b.options[o.key];if(o.choices&&!o.choices.includes(String(v)))fail(`${p}.options.${o.key}`,'Unsupported option.');if(typeof v==='number')num(v,o.min??1,o.max??100000,`${p}.options.${o.key}`);}
  }
  return issues;
}
export function parseConfig(value:unknown):SearchConfig{
  const defaults=defaultConfig();
  // Migrate the backend map before validation: drop entries this release no longer ships, add ones it now ships.
  if(value&&typeof value==='object'&&!Array.isArray(value)&&(value as any).backends&&typeof (value as any).backends==='object'){
    const raw=structuredClone(value) as any;
    for(const id of Object.keys(raw.backends))if(!(id in defaults.backends))delete raw.backends[id];
    for(const [id,fallback] of Object.entries(defaults.backends))if(!raw.backends[id])raw.backends[id]=fallback;
    // A browser-only backend used to be given a credential reference of its own, named after the
    // backend. The token belongs to the browser, so that generated name is dropped and the endpoint
    // token is expected under the shared browser reference; a reference the user chose is left alone.
    for(const d of catalog){
      if(!d.modes.every(m=>m.mode==='browser'))continue;
      const row=raw.backends[d.id];
      if(row&&row.credentialRef===legacyCredentialRef(d.id))row.credentialRef='';
    }
    value=raw;
  }
  const issues=validateConfig(value);
  if(issues.length)throw new Error(issues.map(x=>`${x.path}: ${x.message}`).join('\n'));
  return structuredClone(value) as SearchConfig;
}
