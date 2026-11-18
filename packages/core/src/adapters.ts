import type { AdapterInput, AdapterResult, Source } from './types.js';
import { requestJson, requestText, SearchError, type TransportOptions } from './transport.js';
import { callMcp } from './mcp.js';
import { languageFor, regionFor } from './locale-map.js';
import { DEFAULT_MAX_CONCURRENT_READS } from './browser-limits.js';
import { searchTencent } from './tencent.js';
import { searchReddit, type RedditCredentials } from './reddit/index.js';
import { parseXCredentials, searchX, type XCredentials } from './x/index.js';
import { searchXhs } from './xhs/index.js';
type Row=Record<string,unknown>;
const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const array=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const string=(v:unknown):string|undefined=>typeof v==='string'?v:undefined;
function sources(rows:unknown,keys={title:'title',url:'url',snippet:'snippet',date:'published_at'}):Source[]{
  if(!Array.isArray(rows))throw new SearchError('protocol','Expected a results array from provider.');
  return rows.flatMap(v=>{const r=obj(v);const url=string(r[keys.url]);if(!url)return [];try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return [];}catch{return [];}
    // Every field is optional, and an explicit undefined is not valid JSON: the tool layer refuses
    // such a value outright, so absent fields are simply left out.
    const title=string(r[keys.title]);const snippet=string(r[keys.snippet]);const date=string(r[keys.date]);
    return [{url,...(title?{title}:{}),...(snippet?{snippet}:{}),...(date?{publishedAt:date}:{})}];});
}

/**
 * Backends that read through the shared browser. A backend added here gets the endpoint, the session
 * file and the timeout from the shared browser configuration, and needs no other wiring.
 */
export interface BrowserRead {
  /**
   * Browser reads get the endpoint, the optional session file, the per-site read cap and the
   * caller's signal. The cap comes from the shared browser configuration and is part of the session
   * identity, so a reader that drops it would silently join a differently bounded session.
   */
  search(input:{query:string;maxResults:number;options:Record<string,unknown>;key?:string},ctx:{wsEndpoint:string;statePath?:string;timeoutMs:number;maxConcurrentReads:number;signal:AbortSignal}):Promise<Source[]>;
}

export const browserBackends:Record<string,BrowserRead>={};
import { registerBrowserBackends } from './browser-backends.js';
registerBrowserBackends(browserBackends);

export async function runAdapter(id:string,i:AdapterInput,t:TransportOptions):Promise<AdapterResult>{
  const b=i.backend;const o=b.options;const c=i.config;const headers:Record<string,string>={'Content-Type':'application/json'};
  const browser=browserBackends[id];
  if(browser){
    // The browser belongs to whoever runs the container, so there is no attempt budget to reserve:
    // one page read is one read on their own infrastructure.
    const endpoint=String(c.browser?.endpoint||o.wsEndpoint||b.endpoint||'');
    if(!endpoint)throw new SearchError('configuration',`${id} reads through a browser, but no endpoint is configured. Set the shared browser endpoint, or this backend's own.`);
    const statePath=String(o.statePath||c.browser?.statePath||'');
    const timeoutMs=Number(c.browser?.timeoutMs||b.timeoutMs);
    const maxConcurrentReads=Number(c.browser?.maxConcurrentReads??DEFAULT_MAX_CONCURRENT_READS);
    const sources=await browser.search({query:i.query,maxResults:i.maxResults,options:o,key:i.key},{wsEndpoint:endpoint,...(statePath?{statePath}:{}),timeoutMs,maxConcurrentReads,signal:t.signal});
    return {sources};
  }
  if(id==='x'){
    const credentials:XCredentials=parseXCredentials(i.key);
    if(b.mode!=='key'&&b.mode!=='session')throw new SearchError('configuration','X supports only the key and session access modes.');
    // The X adapters own their HTTP calls, so reserve the attempt budget here.
    await t.beforeAttempt();t.onAttempt();
    const postsPerSearch=Number(o.postsPerSearch??0);
    return {sources:await searchX({query:i.query,maxResults:i.maxResults},{mode:b.mode==='key'?'key':'session',credentials,signal:t.signal,timeoutMs:b.timeoutMs,postsPerSearch:postsPerSearch>0?postsPerSearch:undefined,fetch:t.fetch})};
  }
  if(id==='reddit'){
    let credentials:RedditCredentials={};
    if(b.mode==='oauth'){try{const parsed=JSON.parse(i.key??'');if(!parsed||typeof parsed!=='object')throw 0;credentials=parsed as RedditCredentials;}catch{throw new SearchError('configuration','Reddit OAuth credentials must be JSON with clientId and clientSecret.');}if(!credentials.clientId||!credentials.clientSecret)throw new SearchError('configuration','Reddit OAuth credentials require clientId and clientSecret.');}
    // This adapter owns its HTTP calls (token flow + GraphQL), so reserve the attempt budget here.
    await t.beforeAttempt();t.onAttempt();
    return {sources:await searchReddit({query:i.query,maxResults:i.maxResults,sort:String(o.sort||'relevance'),time:String(o.time||'all'),subreddit:String(o.subreddit||'')||undefined},{mode:b.mode==='oauth'?'oauth':'anonymous',credentials,signal:t.signal,timeoutMs:b.timeoutMs,fetch:t.fetch})};
  }

  const key=b.mode==='key'?i.key:undefined;
  const json=(body:unknown,h:Record<string,string>=headers)=>requestJson(b.endpoint,{method:'POST',headers:h,body:JSON.stringify(body)},t);
  const get=(params:Record<string,unknown>,h:Record<string,string>=headers)=>{const url=new URL(b.endpoint);for(const[k,v]of Object.entries(params))if(v!==undefined&&v!=='')url.searchParams.set(k,String(v));return requestJson(url.href,{headers:h},t);};
  const bearer=()=>{if(key)headers.Authorization=`Bearer ${key}`;};
  if(id==='keenable'){
    headers['X-Keenable-Title']=String(o.clientTitle);if(key)headers['X-API-Key']=key;
    const r=obj(await json({query:i.query,max_results:i.maxResults,snippet_max_length:o.snippet_max_length,...(c.includeDomains.length?{site:c.includeDomains.join(',')}: {})}));return {sources:sources(r.results)};
  }
  if(id==='anysearch'){bearer();const r=obj(await json({query:i.query,max_results:Math.min(i.maxResults,10),zone:o.zone,format:'json',...(languageFor('anysearch',c.language)?{language:languageFor('anysearch',c.language)}:{})}));if(r.code!==undefined&&r.code!==0&&r.code!==200)throw new SearchError('protocol','AnySearch reported an application-level error; inspect the account console.');return {sources:sources(obj(r.data).results)};}
  if(id==='linkup'){bearer();const r=obj(await json({q:i.query,depth:o.depth,outputType:'searchResults',maxResults:i.maxResults}));return {sources:sources(r.results,{title:'name',url:'url',snippet:'content',date:'publishedAt'})};}
  if(id==='tavily'){bearer();const r=obj(await json({query:i.query,max_results:Math.min(i.maxResults,20),search_depth:o.search_depth,auto_parameters:false,topic:o.topic,include_answer:o.include_answer,include_domains:c.includeDomains,exclude_domains:c.excludeDomains,...(c.recency!=='any'?{time_range:c.recency}:{})}));return {sources:sources(r.results,{title:'title',url:'url',snippet:'content',date:'published_date'}),content:string(r.answer)};}
  if(id==='brave'){if(key)headers['X-Subscription-Token']=key;const r=obj(await get({q:i.query,count:Math.min(i.maxResults,20),search_lang:languageFor('brave',c.language),country:regionFor('brave',c.region),safesearch:c.safeSearch?'strict':'off',freshness:({any:undefined,day:'pd',week:'pw',month:'pm',year:'py'}as const)[c.recency]}));return {sources:sources(obj(r.web).results,{title:'title',url:'url',snippet:'description',date:'page_age'})};}
  if(id==='serper'){if(key)headers['X-API-KEY']=key;const r=obj(await json({q:i.query,num:i.maxResults,hl:languageFor('serper',c.language),gl:regionFor('serper',c.region),tbs:({any:undefined,day:'qdr:d',week:'qdr:w',month:'qdr:m',year:'qdr:y'}as const)[c.recency]}));return {sources:sources(r.organic,{title:'title',url:'link',snippet:'snippet',date:'date'})};}
  if(id==='searxng'){bearer();const r=obj(await get({q:i.query,format:'json',language:languageFor('searxng',c.language)||'auto',time_range:c.recency==='any'?undefined:c.recency,safesearch:c.safeSearch?2:0,engines:o.engines,categories:o.categories}));return {sources:sources(r.results,{title:'title',url:'url',snippet:'content',date:'publishedDate'})};}
  if(id==='exa'&&b.mode==='key'){headers['x-api-key']=key!;const date=c.recency==='any'?undefined:new Date(Date.now()-({day:1,week:7,month:30,year:365}[c.recency])*86400000).toISOString();const r=obj(await json({query:i.query,numResults:i.maxResults,type:o.type,includeDomains:c.includeDomains,excludeDomains:c.excludeDomains,startPublishedDate:date,contents:{text:{maxCharacters:o.textMaxCharacters}}}));return {sources:sources(r.results,{title:'title',url:'url',snippet:'text',date:'publishedDate'})};}
  if((id==='exa'||id==='parallel'||id==='you')&&b.mode==='anonymous'){
    const tool=id==='exa'?'web_search_exa':id==='you'?'you-search':'web_search';
    const args=id==='exa'?{query:i.query,objective:i.query,numResults:i.maxResults}:id==='you'?{query:i.query,count:i.maxResults}:{objective:i.query,search_queries:[i.query]};
    const endpoint=new URL(b.endpoint);if(id==='you')endpoint.searchParams.set('profile','free');if(id==='parallel')endpoint.searchParams.set('tools','web_search');
    const result=await callMcp(endpoint.href,tool,args,t);const structured=obj(result.structuredContent);
    if(Array.isArray(structured.results))return {sources:sources(structured.results)};
    const text=array(result.content).map(v=>string(obj(v).text)||'').join('\n');
    if(!text.trim())throw new SearchError('protocol','MCP search response has no recognized result payload.');
    try{const parsed=obj(JSON.parse(text));const list=[parsed.results,obj(parsed.data).results,obj(parsed.results).web].find(Array.isArray);if(Array.isArray(list))return {sources:sources(list)};}catch(e){if(e instanceof SearchError)throw e;}
    const found:Source[]=[];const blocks=text.split(/(?=Title:)/);for(const block of blocks){const url=block.match(/URL:\s*(https?:\/\/\S+)/)?.[1];if(url)found.push({url,title:block.match(/Title:\s*(.+)/)?.[1],snippet:block.split(/(?:Text|Content):\s*/).slice(1).join(' ').slice(0,4000)});}
    if(!found.length&&text.trim())throw new SearchError('protocol','MCP result format contains no verifiable source URLs.');return {sources:found};
  }
  if(id==='parallel'){if(key)headers['x-api-key']=key;const r=obj(await json({search_queries:[i.query],mode:o.mode,advanced_settings:{max_results:i.maxResults}}));const rows=array(r.results).map(v=>{const row=obj(v);return {...row,excerpt:array(row.excerpts).filter(x=>typeof x==='string').join('\n').slice(0,Number(o.maxCharactersPerResult))};});return {sources:sources(rows,{title:'title',url:'url',snippet:'excerpt',date:'publish_date'})};}
  if(id==='you'){if(key)headers['X-API-Key']=key;const r=obj(await json({query:i.query,count:i.maxResults,strict_operators:true,...(languageFor('you',c.language)?{language:languageFor('you',c.language)}:{}),...(regionFor('you',c.region)?{country:regionFor('you',c.region)}:{})}));return {sources:sources(obj(r.results).web,{title:'title',url:'url',snippet:'description',date:'page_age'})};}
  if(id==='baidu'){bearer();const r=obj(await json({messages:[{role:'user',content:i.query}],search_source:'baidu_search_v2',edition:o.edition,resource_type_filter:[{type:'web',top_k:i.maxResults}]}));return {sources:sources(r.references,{title:'title',url:'url',snippet:'snippet',date:'date'})};}
  if(id==='doubao'){bearer();const r=obj(await json({Query:i.query,SearchType:'web',Count:i.maxResults,Filter:{NeedUrl:true},QueryControl:{QueryRewrite:o.queryRewrite}}));if(obj(r.ResponseMetadata).Error)throw new SearchError('protocol','Doubao returned an application-level error.');return {sources:sources(obj(r.Result).WebResults,{title:'Title',url:'Url',snippet:'Snippet',date:'PublishTime'})};}
  if(id==='zhihu-web'||id==='zhihu-site'){bearer();headers['X-Request-Timestamp']=String(Math.floor(Date.now()/1000));const r=obj(await get({Query:i.query,Count:Math.min(i.maxResults,id==='zhihu-web'?20:10),...(id==='zhihu-web'?{SearchDB:o.SearchDB,Filter:o.Filter}:{})}));if(r.Code!==0)throw new SearchError('protocol','Zhihu reported an application-level failure; check Access Secret and account permissions.');return {sources:sources(obj(r.Data).Items,{title:'Title',url:'Url',snippet:'ContentText',date:'PublishTime'})};}
  if(id==='open-websearch'){const r=obj(await json({query:i.query,limit:i.maxResults,engines:[o.engine],searchMode:o.searchMode}));if(r.status!=='ok')throw new SearchError('protocol','Self-hosted search daemon reported failure.');return {sources:sources(r.data,{title:'title',url:'url',snippet:'description',date:'date'})};}
  if(id==='serpex'){bearer();const r=obj(await json({q:i.query}));return {sources:sources(r.results),warnings:['Serpex controls its own internal upstream routing; the plugin did not switch providers.']};}
  if(id==='mojeek'){const r=obj(await get({q:i.query,api_key:key,fmt:'json'}));const response=obj(r.response);if(response.status!=='OK'&&response.status!==200&&response.status!=='200')throw new SearchError('protocol','Mojeek reported an application-level error.');return {sources:sources(response.results,{title:'title',url:'url',snippet:'desc',date:'date'})};}
  if(id==='deepseek'){bearer();const r=obj(await json({query:i.query,count:i.maxResults,need_content:o.need_content}));return {sources:sources(r.results,{title:'title',url:'url',snippet:'snippet',date:'date'})};}
  if(id==='anthropic'){if(key)headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';const r=obj(await json({model:o.model,max_tokens:o.maxTokens,tools:[{type:'web_search_20250305',name:'web_search',max_uses:o.maxUses,...(c.includeDomains.length?{allowed_domains:c.includeDomains}:{}),...(c.excludeDomains.length?{blocked_domains:c.excludeDomains}:{})}],messages:[{role:'user',content:i.query}]}));const result:Source[]=[];for(const block of array(r.content)){const v=obj(block);if(v.type==='web_search_tool_result'){if(obj(v.content).type==='web_search_tool_result_error')throw new SearchError('protocol','Anthropic search tool reported failure.');for(const x of array(v.content)){const s=obj(x);if(s.type==='web_search_result')result.push(...sources([s],{title:'title',url:'url',snippet:'page_content',date:'page_age'}));}}}return {sources:result};}
  if(id==='openai'){bearer();const r=obj(await json({model:o.model,input:i.query,tools:[{type:'web_search'}],tool_choice:'required',include:['web_search_call.action.sources'],max_output_tokens:o.maxOutputTokens}));if(r.error||r.status==='failed'||r.status==='incomplete')throw new SearchError('protocol','OpenAI response did not complete.');const result:Source[]=[];for(const output of array(r.output))for(const block of array(obj(output).content))for(const a of array(obj(block).annotations)){const citation=obj(a);if(citation.type==='url_citation')result.push(...sources([citation]));}return {sources:result};}
  if(id==='ddg'){
    const raw=await requestText(b.endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({q:i.query}).toString()},t);
    if(/anomaly|challenge-form|bots use DuckDuckGo/i.test(raw))throw new SearchError('rate-limit','DuckDuckGo returned a challenge; no bypass was attempted.');
    const decode=(s:string)=>s.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim();
    const result:Source[]=[];for(const match of raw.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)){let url=decode(match[1]!);try{const u=new URL(url,'https://duckduckgo.com');url=u.searchParams.get('uddg')||u.href;}catch{continue;}result.push(...sources([{url,title:decode(match[2]!)}]));}
    if(!result.length&&!/No results found|result--no-result/.test(raw))throw new SearchError('protocol','DuckDuckGo HTML layout was not recognized.');return {sources:result};
  }
  throw new SearchError('unverified','Backend adapter is not verified and cannot be called.');
}
