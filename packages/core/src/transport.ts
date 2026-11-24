import type { FailureKind, RetryConfig } from './types.js';
import { initWithAppUserAgent } from './ua.js';

/**
 * How far a refusal reaches. A `subject` refusal (a private or deleted note) concerns the thing that
 * was read; a `site` refusal (a challenge, an expired sign-in) concerns the whole site, so queued
 * reads for that site must not start.
 */
export type FailureScope = 'site' | 'subject';

export class SearchError extends Error {
  /**
   * Set by the reader that classified the refusal. `site` closes the session's site gate, which
   * rejects queued reads for that site before their slot is granted.
   */
  public scope?: FailureScope;
  constructor(public kind:FailureKind,message:string,public status?:number,public attempts=0){super(message);this.name='SearchError';}
  /** Mark this refusal as reaching every read for the site, not only the one that met it. */
  withScope(scope: FailureScope): this { this.scope = scope; return this; }
}
export interface TransportOptions {
  retry: RetryConfig; signal: AbortSignal; attemptTimeoutMs: number;
  beforeAttempt: () => void | Promise<void>; onAttempt: () => void;
  fetch?: typeof fetch;
  /**
   * A caller with its own byte budget lowers the response bound. When set, the body is read eagerly
   * and overrunning throws before the body is handed to a parser; the upstream stream is cancelled at
   * that point. Absent, the historical 4 MiB streaming guard applies unchanged.
   */
  maxResponseBytes?: number;
  oversizeKind?: FailureKind;
  oversizeMessage?: string;
}
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
      if(response.ok){
        // Only a tool call carries a page representation, and only that response is worth buffering
        // under the caller's bound. Other requests (handshakes, list calls) keep the shared guard.
        const body=typeof init?.body==='string'?init.body:'';
        if(options.maxResponseBytes!==undefined&&body.includes('"tools/call"')){
          const requestId=jsonRpcId(body);
          return await eagerlyBounded(response,options.maxResponseBytes,attempts,options.oversizeKind??'limit',options.oversizeMessage,requestId);
        }
        return cappedResponse(response,attempts);
      }
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
/** The JSON-RPC id of a request body, when it is a single request and not a batch. */
function jsonRpcId(body:string):string|number|undefined{
  try{
    const parsed=JSON.parse(body) as {id?:unknown};
    return typeof parsed.id==='string'||typeof parsed.id==='number'?parsed.id:undefined;
  }catch{return undefined;}
}

/**
 * Offset just past the SSE event that carries the final JSON-RPC response for `id`, or undefined when
 * that event has not arrived yet. A server may keep the response stream open after sending the result;
 * an event stream therefore ends at the response, never at EOF.
 */
function sseFinalEventEnd(buffer:string,id:string|number):number|undefined{
  const pattern=/\r?\n\r?\n/g;
  let start=0;
  for(;;){
    const boundary=pattern.exec(buffer);
    if(!boundary)return undefined;
    const block=buffer.slice(start,boundary.index);
    start=boundary.index+boundary[0].length;
    const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)continue;
    try{
      const message=JSON.parse(data) as {id?:unknown;result?:unknown;error?:unknown};
      if((typeof message.id==='string'||typeof message.id==='number')&&String(message.id)===String(id)&&('result' in message||'error' in message))return start;
    }catch{/* not a JSON payload yet */ }
  }
}

/**
 * Read a body under an explicit byte budget and stop at the boundary: the reader is cancelled at the
 * first overrun, so a caller with a configured limit never buffers or parses the rest of the response.
 *
 * A `tools/call` request is answered with either finite JSON or an event stream. For a stream, the
 * response ends at the event carrying the matching JSON-RPC result: servers may keep the stream open
 * afterwards, and waiting for EOF would turn a valid result into a route timeout. The returned body is
 * trimmed to that event, so the client sees one complete stream and resolves immediately.
 */
async function eagerlyBounded(response:Response,maxBytes:number,attempts:number,kind:FailureKind,message:string|undefined,requestId?:string|number):Promise<Response>{
  if(!response.body)return response;
  const isEventStream=(response.headers.get('content-type')??'').includes('text/event-stream');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  const decoder=new TextDecoder();let text='';
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    if(!value)continue;
    size+=value.byteLength;
    if(size>maxBytes){
      await reader.cancel().catch(()=>undefined);
      throw new SearchError(kind,message??`Response exceeds the ${maxBytes}-byte limit.`,response.status,attempts);
    }
    chunks.push(value);
    if(isEventStream&&requestId!==undefined){
      text+=decoder.decode(value,{stream:true});
      const end=sseFinalEventEnd(text,requestId);
      if(end!==undefined){
        await reader.cancel().catch(()=>undefined);
        return new Response(new TextEncoder().encode(text.slice(0,end)),{status:response.status,statusText:response.statusText,headers:response.headers});
      }
    }
  }
  if(isEventStream&&requestId!==undefined&&text){
    text+=decoder.decode();
    return new Response(new TextEncoder().encode(text),{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  const body=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
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
