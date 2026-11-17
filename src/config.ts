import { catalog } from './catalog.js';
import { LANGUAGES, REGIONS } from './locale-map.js';
import type { ConfigIssue, SearchConfig } from './types.js';
export function defaultConfig(): SearchConfig {
  return {
    mode:'parallel', singleBackend:'keenable', maxResults:8, concurrency:4, overallTimeoutMs:30000,
    language:'', region:'', recency:'any', safeSearch:true, includeDomains:[], excludeDomains:[],dedup:'url',fusion:'rrf',
    retry:{enabled:true,statuses:[408,429,500,502,503,504],maxRetries:2,initialDelayMs:500,maxDelayMs:5000,networkErrors:false,timeouts:false},
    cache:{enabled:true,ttlSeconds:900,maxEntries:100},breaker:{enabled:false,threshold:3,cooldownMs:60000},diagnostics:{enabled:true,maxEntries:50},tools:{webSearchPlus:true,compactByDefault:false},
    backends:Object.fromEntries(catalog.map(d=>[d.id,{enabled:false,mode:d.modes[0]!.mode,endpoint:d.modes[0]!.endpoint,credentialRef:`DSH_SEARCH_${d.id.replaceAll('-','_').toUpperCase()}_KEY`,timeoutMs:15000,rateLimitPerMinute:0,dailyAttemptLimit:0,options:Object.fromEntries(d.options.map(o=>[o.key,o.default]))}]))
  };
}
/** Loopback, RFC1918, CGNAT (which includes tailnets) and unique-local IPv6 are treated as local. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  if (host.startsWith('fe80:')) return true;
  return false;
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
  for(const d of catalog){const b=c.backends[d.id]!;const p=`backends.${d.id}`;
    choice(b.mode,d.modes.map(m=>m.mode),`${p}.mode`);
    if(b.enabled&&d.status==='unverified')fail(`${p}.enabled`,'Backend protocol is not verified.');
    if(b.endpoint){try{
      const url=new URL(b.endpoint);if(url.username||url.password||url.hash||url.search)throw 0;
      const local=isPrivateHost(url.hostname);
      // A browser backend points at a Playwright server, whose endpoint is a WebSocket URL.
      const schemes=url.protocol==='ws:'||url.protocol==='wss:'?['ws:','wss:']:['http:','https:'];
      if(!schemes.includes(url.protocol))throw 0;
      // Unencrypted transports are only acceptable on loopback; anything remote must be TLS.
      const plain=url.protocol==='http:'||url.protocol==='ws:';if(plain&&!local)throw 0;
    }catch{fail(`${p}.endpoint`,'Use an HTTPS or WSS endpoint without credentials, query, or fragment; unencrypted HTTP and WS are allowed only on loopback.');}}
    else if(b.enabled)fail(`${p}.endpoint`,'An endpoint is required.');
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.credentialRef))fail(`${p}.credentialRef`,'Expected an environment-style credential reference.');
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
    value=raw;
  }
  const issues=validateConfig(value);
  if(issues.length)throw new Error(issues.map(x=>`${x.path}: ${x.message}`).join('\n'));
  return structuredClone(value) as SearchConfig;
}
