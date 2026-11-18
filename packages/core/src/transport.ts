import type { FailureKind, RetryConfig } from './types.js';
import { initWithAppUserAgent } from './ua.js';
export class SearchError extends Error {
  constructor(public kind:FailureKind,message:string,public status?:number,public attempts=0){super(message);this.name='SearchError';}
}
export interface TransportOptions { retry:RetryConfig; signal:AbortSignal; attemptTimeoutMs:number; beforeAttempt:()=>void|Promise<void>; onAttempt:()=>void; fetch?:typeof fetch }
export function abortError(signal:AbortSignal):SearchError{return new SearchError(signal.reason instanceof DOMException&&signal.reason.name==='TimeoutError'?'timeout':'cancelled','Request stopped by cancellation or deadline.');}
export async function delay(ms:number,signal:AbortSignal):Promise<void>{if(signal.aborted)throw abortError(signal);await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(abortError(signal));};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);signal.addEventListener('abort',stop,{once:true});});}
export function retryAfter(value:string|null,now=Date.now()):number|undefined {if(!value)return;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const time=Date.parse(value);if(Number.isFinite(time))return Math.max(0,time-now);}
/**
 * The retry, deadline and redirect policy every adapter shares. It returns a Response so callers
 * that speak a protocol (MCP) can hand it to their own client, and requestText sits on top of it.
 */
export async function fetchWithPolicy(url:string,init:RequestInit,options:TransportOptions):Promise<Response>{
  const fetcher=options.fetch??fetch;let attempts=0;
  for(;;){
    if(options.signal.aborted)throw abortError(options.signal);
    await options.beforeAttempt();if(options.signal.aborted)throw abortError(options.signal);attempts++;options.onAttempt();
    const timeout=AbortSignal.timeout(options.attemptTimeoutMs);
    const signal=AbortSignal.any(init.signal?[options.signal,timeout,init.signal]:[options.signal,timeout]);
    let error:SearchError;let wait:number|undefined;
    try{
      const response=await fetcher(url,{...initWithAppUserAgent(init),signal,redirect:'error'});
      if(response.ok)return cappedResponse(response,attempts);
      const text=await response.clone().text().then(t=>t.slice(0,32768)).catch(()=>'');
      const quota=response.status===402||/insufficient[_ -]?(balance|credit|fund)|quota[_ -]?(exhausted|exceeded)|credits?[_ -]?exhausted/i.test(text);
      const kind:FailureKind=quota?'quota':[401,403].includes(response.status)?'authentication':response.status===429?'rate-limit':'http';
      error=new SearchError(kind,quota?'Provider quota exhausted or balance insufficient.':`HTTP ${response.status}; check backend settings and account status.`,response.status,attempts);
      if(quota||!options.retry.statuses.includes(response.status))throw error;
      if([429,503].includes(response.status))wait=retryAfter(response.headers.get('retry-after'));
    }catch(caught){
      if(options.signal.aborted){const e=abortError(options.signal);e.attempts=attempts;throw e;}
      if(caught instanceof SearchError){if(caught.kind==='quota'||caught.kind==='authentication'||caught.kind==='protocol'||!caught.status||!options.retry.statuses.includes(caught.status))throw caught;error=caught;}
      else {const timedOut=timeout.aborted;error=new SearchError(timedOut?'timeout':'network',timedOut?'Backend attempt timed out.':'Network request failed; check connectivity and endpoint.',undefined,attempts);if(timedOut?!options.retry.timeouts:!options.retry.networkErrors)throw error;}
    }
    if(!options.retry.enabled||attempts>options.retry.maxRetries)throw error;
    if(wait!==undefined&&wait>options.retry.maxDelayMs)throw new SearchError(error.kind,'Provider retry delay exceeds the configured maximum; no early retry was sent.',error.status,attempts);
    await delay(wait??Math.min(options.retry.maxDelayMs,options.retry.initialDelayMs*2**(attempts-1)*(0.8+Math.random()*0.4)),options.signal);
  }
}
/** Bound response bytes before anyone parses them; upstream bodies may include credentials. */
function cappedResponse(response:Response,attempts:number):Response{
  if(!response.body)return response;
  let bytes=0;
  const bounded=response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(part,controller){bytes+=part.byteLength;if(bytes>4*1024*1024){controller.error(new SearchError('protocol','Response exceeds the 4 MiB limit.',response.status,attempts));return;}controller.enqueue(part);}}));
  return new Response(bounded,{status:response.status,statusText:response.statusText,headers:response.headers});
}
export async function requestText(url:string,init:RequestInit,options:TransportOptions):Promise<string>{
  const response=await fetchWithPolicy(url,init,options);
  return await response.text();
}
export async function requestJson(url:string,init:RequestInit,options:TransportOptions):Promise<unknown>{const text=await requestText(url,init,options);try{return JSON.parse(text);}catch{throw new SearchError('protocol','Provider returned invalid JSON.');}}
