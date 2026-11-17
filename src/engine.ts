import { createHash } from 'node:crypto';
import { catalog } from './catalog.js';
import { runAdapter } from './adapters.js';
import { abortError, SearchError } from './transport.js';
import type { BackendOutcome, SearchConfig, SearchInput, SearchOverrides, SearchResult, Source } from './types.js';
export function revision(config:SearchConfig):string{return createHash('sha256').update(JSON.stringify(config)).digest('hex');}
export class SearchEngine {
  private cache=new Map<string,{expires:number;result:SearchResult}>();
  private history:BackendOutcome[]=[];
  private usage=new Map<string,{attempts:number;day:string;recent:number[]}>();
  private failures=new Map<string,{count:number;until:number}>();
  constructor(private config:SearchConfig,private resolveKey:(ref:string)=>Promise<string|undefined>,private fetcher:typeof fetch=fetch,private reserveAttempt?:(id:string,mode:string,perMinute:number,daily:number)=>Promise<{attempts:number;day:string}> ){}
  clearCache(){this.cache.clear();}
  clearDiagnostics(){this.history=[];}
  diagnostics(){return structuredClone(this.history);}
  counters(){return Object.fromEntries([...this.usage].map(([id,u])=>[id,{attempts:u.attempts,day:u.day}]));}
  async search(input:SearchInput,signal?:AbortSignal,onlyBackend?:string,overrides?:SearchOverrides):Promise<SearchResult>{
    if(typeof input.query!=='string'||!input.query.trim()||input.query.length>10000)throw new SearchError('configuration','Query must contain 1–10,000 characters.');
    if(input.maxResults!==undefined&&(!Number.isInteger(input.maxResults)||input.maxResults<1||input.maxResults>50))throw new SearchError('configuration','Result limit must be 1–50.');
    if(overrides?.maxResults!==undefined&&(!Number.isInteger(overrides.maxResults)||overrides.maxResults<1||overrides.maxResults>50))throw new SearchError('configuration','Result limit must be 1–50.');
    const c=this.config;const max=input.maxResults??overrides?.maxResults??c.maxResults;const outer=signal??new AbortController().signal;
    const deadline=AbortSignal.timeout(c.overallTimeoutMs);const combined=AbortSignal.any([outer,deadline]);
    // Per-call overrides never touch saved configuration; anything that cannot be honoured is reported.
    const notes:string[]=[];
    const enabledIds=()=>catalog.filter(d=>c.backends[d.id]?.enabled).map(d=>d.id);
    const resolveIds=():string[]=>{
      if(onlyBackend)return [onlyBackend];
      const mode=overrides?.mode??c.mode;
      if(mode==='single'){
        if(overrides?.backend||overrides?.backends?.length)notes.push('Note: single mode ignores the requested backend selection; the configured single backend was used.');
        return [c.singleBackend];
      }
      if(overrides?.backend)notes.push('Note: parallel mode ignores a single backend argument; pass backends instead.');
      const enabled=enabledIds();
      if(!overrides?.backends?.length)return enabled;
      const wanted=[...new Set(overrides.backends.map(value=>String(value).trim()).filter(Boolean))];
      const usable=wanted.filter(id=>enabled.includes(id));
      const rejected=wanted.filter(id=>!enabled.includes(id));
      if(rejected.length)notes.push(`Ignored backends that are not enabled: ${rejected.join(', ')}.`);
      if(!usable.length)notes.push('None of the requested backends are enabled. Ask the user which backends to enable, or omit the selection to use every enabled backend.');
      return usable;
    };
    const ids=resolveIds();
    const cacheKey=JSON.stringify([revision(c),input.query,max,ids]);
    const hit=!notes.length?this.cache.get(cacheKey):undefined;if(!onlyBackend&&c.cache.enabled&&hit&&hit.expires>Date.now())return {...structuredClone(hit.result),cached:true,content:hit.result.content+'\n[Cache hit: no upstream requests were made.]'};
    const outcomes:BackendOutcome[]=new Array(ids.length);let cursor=0;
    const worker=async()=>{while(cursor<ids.length){const index=cursor++;const id=ids[index]!;outcomes[index]=await this.call(id,input.query,max,combined);}};
    await Promise.all(Array.from({length:Math.min(c.concurrency,ids.length)},worker));
    if(outer.aborted)throw abortError(outer);
    const success=outcomes.filter(o=>o.ok);const merged=new Map<string,{source:Source;score:number;order:number}>();let order=0;
    for(const outcome of success)for(const [rank,source]of outcome.sources.entries()){
      if(!domainAllowed(source.url,c))continue;
      const key=normalizeUrl(source.url);let existing=merged.get(key);
      if(!existing&&c.dedup==='url-title'&&source.title)existing=[...merged.values()].find(x=>x.source.title?.trim().toLowerCase()===source.title!.trim().toLowerCase());
      if(existing)existing.score+=1/(60+rank+1);else merged.set(key,{source,score:1/(60+rank+1),order:order++});
    }
    const ranked=[...merged.values()].sort((a,b)=>c.fusion==='rrf'?b.score-a.score||a.order-b.order:a.order-b.order);
    const sources=ranked.slice(0,max).map(x=>x.source);
    const failed=outcomes.filter(o=>!o.ok);const report:string[]=[...notes];
    if(!ids.length)report.push('Search failed: no backend is enabled. Ask the user to configure and enable a search backend.');
    else if(!success.length)report.push('Search failed: every selected backend failed. This is not a successful search with no matches.');
    if(failed.length)report.push('IMPORTANT: Inform the user of the following backend failures. No backend, access-mode, endpoint, or credential fallback was attempted.');
    for(const o of outcomes){if(!o.ok)report.push(`[${o.backend}; mode=${o.mode}; attempts=${o.attempts}] FAILED ${o.error!.kind}${o.error!.status?` HTTP ${o.error!.status}`:''}: ${o.error!.message}`);for(const w of o.warnings)report.push(`[${o.backend}] ${w}`);}
    const result:SearchResult={sources,content:report.join('\n'),truncated:ranked.length>max,outcomes,cached:false};
    if(c.diagnostics.enabled){const at=Date.now();this.history.push(...outcomes.map(o=>({...o,sources:[],at})));this.history=this.history.slice(-c.diagnostics.maxEntries);}
    // Failures are never cached, so a temporary failure cannot be hidden by a cache hit.
    if(!onlyBackend&&!notes.length&&c.cache.enabled&&success.length&&failed.length===0){this.cache.set(cacheKey,{expires:Date.now()+c.cache.ttlSeconds*1000,result:structuredClone(result)});while(this.cache.size>c.cache.maxEntries)this.cache.delete(this.cache.keys().next().value!);}
    return result;
  }
  private async call(id:string,query:string,maxResults:number,signal:AbortSignal):Promise<BackendOutcome>{
    const started=Date.now();const d=catalog.find(x=>x.id===id);const b=this.config.backends[id];let attempts=0;const warnings:string[]=[];
    const result:BackendOutcome={backend:id,mode:b?.mode??'anonymous',ok:false,attempts:0,durationMs:0,sources:[],warnings};
    try{
      if(!d||!b||!b.enabled)throw new SearchError('configuration','Backend is disabled or unknown.');
      if(d.status==='unverified')throw new SearchError('unverified','Backend protocol is not verified.');
      if(signal.aborted)throw abortError(signal);
      const circuit=this.failures.get(id);if(this.config.breaker.enabled&&circuit&&circuit.until>Date.now())throw new SearchError('circuit-open','Backend circuit is open; no call or fallback was sent.');
      const key=b.mode==='key'?await this.resolveKey(b.credentialRef):undefined;
      if(b.mode==='key'&&!key)throw new SearchError('configuration','API-key mode selected but credential is missing. Ask the user to set the credential.');
      for(const [field,active]of [['language',!!this.config.language],['region',!!this.config.region],['recency',this.config.recency!=='any'],['safeSearch',this.config.safeSearch]]as const)if(active&&!d.capabilities.includes(field))warnings.push(`${field} is unsupported by this backend and was not applied upstream.`);
      if(id==='deepseek'&&query.length>128)throw new SearchError('configuration','DeepSeek search query must not exceed 128 characters.');
      const response=await runAdapter(id,{query,maxResults,config:this.config,backend:b,key,signal},{signal,retry:this.config.retry,attemptTimeoutMs:b.timeoutMs,fetch:this.fetcher,onAttempt:()=>{attempts++;},beforeAttempt:async()=>{
        if(this.reserveAttempt){const saved=await this.reserveAttempt(id,b.mode,b.rateLimitPerMinute,b.dailyAttemptLimit);this.usage.set(id,{...saved,recent:[]});return;}
        const day=new Date().toISOString().slice(0,10);let u=this.usage.get(id);if(!u||u.day!==day){u={attempts:0,day,recent:[]};this.usage.set(id,u);}u.recent=u.recent.filter(t=>t>Date.now()-60000);
        if(b.dailyAttemptLimit&&u.attempts>=b.dailyAttemptLimit)throw new SearchError('budget','Local daily attempt cap reached (UTC reset; not provider balance).');
        if(b.rateLimitPerMinute&&u.recent.length>=b.rateLimitPerMinute)throw new SearchError('budget','Local per-minute attempt limit reached.');u.attempts++;u.recent.push(Date.now());
      }});
      result.ok=true;result.sources=response.sources;warnings.push(...response.warnings??[]);this.failures.delete(id);
    }catch(e){const error=e instanceof SearchError?e:new SearchError('protocol','Backend failed unexpectedly; inspect plugin diagnostics.');result.error={kind:error.kind,message:error.message,status:error.status};
      if(attempts&&this.config.breaker.enabled){const old=this.failures.get(id)?.count??0;this.failures.set(id,{count:old+1,until:old+1>=this.config.breaker.threshold?Date.now()+this.config.breaker.cooldownMs:0});}
    }
    result.attempts=attempts;result.durationMs=Date.now()-started;return result;
  }
}
function normalizeUrl(value:string):string{try{const u=new URL(value);u.hash='';for(const k of [...u.searchParams.keys()])if(k.startsWith('utm_')||['fbclid','gclid'].includes(k))u.searchParams.delete(k);u.searchParams.sort();return u.href.replace(/\/$/,'');}catch{return value;}}
function domainAllowed(value:string,c:SearchConfig):boolean{try{const host=new URL(value).hostname.toLowerCase();const matches=(domain:string)=>host===domain.toLowerCase()||host.endsWith('.'+domain.toLowerCase());return (!c.includeDomains.length||c.includeDomains.some(matches))&&!c.excludeDomains.some(matches);}catch{return false;}}
