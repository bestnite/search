import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../src/config.js';
import { catalog } from '../src/catalog.js';
import { SearchEngine } from '../src/engine.js';
import { requestText, retryAfter, SearchError } from '../src/transport.js';
import { runAdapter } from '../src/adapters.js';
const payload={results:[{title:'Example',url:'https://example.org/a',snippet:'Hello'}]};
function mock(fn:(url:string,init:RequestInit)=>Response|Promise<Response>):typeof fetch{return (async(url:any,init:any)=>fn(String(url),init))as typeof fetch;}
function config(){const c=defaultConfig();c.backends.keenable!.enabled=true;c.safeSearch=false;c.retry.initialDelayMs=0;c.retry.maxDelayMs=0;return c;}
test('defaults validate, each candidate is independently addressable, malformed/unknown fields rejected',()=>{assert.deepEqual(validateConfig(defaultConfig()),[]);assert.equal(new Set(catalog.map(d=>d.id)).size,catalog.length);const c=config();c.backends.keenable!.options.bad='secret';assert.ok(validateConfig(c).some(i=>i.path.endsWith('.bad')));assert.ok(validateConfig({}).length);});
test('anonymous mode never resolves or sends a saved key',async()=>{let resolved=0;const e=new SearchEngine(config(),async()=>{resolved++;return 'SECRET';},mock((_url,init)=>{assert.ok(!JSON.stringify(init).includes('SECRET'));assert.equal((init.headers as any)['X-API-Key'],undefined);return Response.json(payload);}));assert.equal((await e.search({query:'hello'})).sources.length,1);assert.equal(resolved,0);});
test('key mode without key fails visibly and never falls back',async()=>{const c=config();c.backends.keenable!.mode='key';let calls=0;const e=new SearchEngine(c,async()=>undefined,mock(()=>{calls++;return Response.json(payload);}));const r=await e.search({query:'hello'});assert.equal(calls,0);assert.match(r.content,/every selected backend failed/);assert.match(r.content,/credential is missing/);assert.equal(r.outcomes[0]!.attempts,0);});
test('disabled backend and all disabled produce no requests',async()=>{let calls=0;const e=new SearchEngine(defaultConfig(),async()=>undefined,mock(()=>{calls++;return Response.json(payload);}));const r=await e.search({query:'hello'});assert.match(r.content,/no backend is enabled/);assert.equal(calls,0);const t=await e.search({query:'hello'},undefined,'keenable');assert.equal(t.outcomes[0]!.error!.kind,'configuration');assert.equal(calls,0);});
test('eligible HTTP status retries same endpoint with bounded attempts',async()=>{let calls=0;const urls:string[]=[];const e=new SearchEngine(config(),async()=>undefined,mock(url=>{urls.push(url);return ++calls<3?new Response('temporary',{status:503}):Response.json(payload);}));const r=await e.search({query:'hello'});assert.equal(r.outcomes[0]!.attempts,3);assert.equal(r.sources.length,1);assert.equal(new Set(urls).size,1);});
test('401 and explicit quota exhaustion do not retry or leak response body',async()=>{for(const [status,body]of [[401,'PRIVATE_SECRET'],[429,'quota_exhausted PASSWORD=xyz'],[402,'generated account password key']]as const){let calls=0;const r=await new SearchEngine(config(),async()=>undefined,mock(()=>{calls++;return new Response(body,{status});})).search({query:'hello'});assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes(body));assert.equal(r.outcomes[0]!.attempts,1);}});
test('partial failures survive returned content; failed requests are not cached',async()=>{const c=config();c.backends.anysearch!.enabled=true;let calls=0;const e=new SearchEngine(c,async()=>undefined,mock(url=>{calls++;return url.includes('anysearch')?new Response('no',{status:401}):Response.json(payload);}));const r=await e.search({query:'hello'});assert.equal(r.sources.length,1);assert.match(r.content,/Inform the user/);assert.match(r.content,/anysearch.*FAILED authentication/);await e.search({query:'hello'});assert.equal(calls,4);});
test('success cache prevents calls; clear cache invalidates',async()=>{let calls=0;const e=new SearchEngine(config(),async()=>undefined,mock(()=>{calls++;return Response.json(payload);}));await e.search({query:'hello'});assert.equal((await e.search({query:'hello'})).cached,true);assert.equal(calls,1);e.clearCache();await e.search({query:'hello'});assert.equal(calls,2);});
test('local attempt budget includes retries and reports skipped requests',async()=>{const c=config();c.backends.keenable!.dailyAttemptLimit=1;let calls=0;const r=await new SearchEngine(c,async()=>undefined,mock(()=>{calls++;return new Response('temporary',{status:503});})).search({query:'hello'});assert.equal(calls,1);assert.equal(r.outcomes[0]!.attempts,1);assert.equal(r.outcomes[0]!.error!.kind,'budget');});
test('domain filtering and URL dedup are deterministic',async()=>{const c=config();c.excludeDomains=['blocked.org'];const e=new SearchEngine(c,async()=>undefined,mock(()=>Response.json({results:[{url:'https://example.org/a?utm_source=test'},{url:'https://example.org/a'},{url:'https://blocked.org/x'}]})));assert.equal((await e.search({query:'hello'})).sources.length,1);});
test('cancellation stops before request',async()=>{const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(new SearchEngine(config(),async()=>undefined,mock(()=>{calls++;return Response.json(payload);})).search({query:'hello'},controller.signal));assert.equal(calls,0);});
test('Retry-After is parsed and never shortened beyond configured bound',async()=>{assert.equal(retryAfter('2'),2000);assert.equal(retryAfter('invalid'),undefined);let calls=0;const c=config();const e=new SearchEngine(c,async()=>undefined,mock(()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});}));const r=await e.search({query:'hello'});assert.equal(calls,1);assert.match(r.content,/retry delay exceeds/);});
test('malformed successful response is a protocol failure not no-results',async()=>{const r=await new SearchEngine(config(),async()=>undefined,mock(()=>Response.json({wrong:[]}))).search({query:'hello'});assert.equal(r.outcomes[0]!.error!.kind,'protocol');});
test('configuration rejects credential-bearing and malformed endpoints but accepts plaintext on any host',()=>{for(const endpoint of ['https://u:p@example.org','https://example.org?key=secret','ws://example.org/socket#secret','ftp://example.org']){const c=config();c.backends.keenable!.endpoint=endpoint;assert.ok(validateConfig(c).some(i=>i.path.endsWith('.endpoint')),`${endpoint} should be rejected`);}for(const endpoint of ['http://search.example.org/api','http://host.containers.internal:3030/socket']){const c=config();c.backends.keenable!.endpoint=endpoint;assert.deepEqual(validateConfig(c).filter(i=>i.path.endsWith('.endpoint')),[],`${endpoint} should be accepted`);}});
test('an adapter that leaves fields undefined cannot break the JSON boundary',async()=>{const c=defaultConfig();c.backends.keenable!.enabled=true;c.mode='single';c.singleBackend='keenable';c.retry.enabled=false;const e=new SearchEngine(c,async()=>undefined,mock(()=>Response.json({results:[{url:'https://example.org/a'}]})));const r=await e.search({query:'q'},new AbortController().signal);const walk=(v:any,path:string)=>{if(v===undefined)throw new Error(`undefined at ${path}`);if(v&&typeof v==='object')for(const[k,item]of Object.entries(v))walk(item,`${path}.${k}`);};walk(r,'result');assert.equal(JSON.parse(JSON.stringify(r)).sources.length,1);});
test('browser-backed readers share one endpoint, one token reference and one session file',async()=>{const {defaultConfig}=await import('../src/config.js');const {validateConfig}=await import('../src/config.js');const {browserBackends}=await import('../src/adapters.js');
 const c=defaultConfig();assert.deepEqual(c.browser,{endpoint:'',credentialRef:'DSH_SEARCH_BROWSER_TOKEN',statePath:'',timeoutMs:60000});
 assert.ok(browserBackends.xiaohongshu,'the browser registry carries the Xiaohongshu reader');
 // A browser backend may leave its own endpoint empty once the shared one is set.
 const shared=defaultConfig();shared.backends.xiaohongshu!.enabled=true;shared.backends.xiaohongshu!.endpoint='';assert.ok(validateConfig(shared).some(i=>i.path==='backends.xiaohongshu.endpoint'),'without any endpoint it is an error');
 shared.browser.endpoint='ws://100.64.0.10:3030/ws';assert.deepEqual(validateConfig(shared).filter(i=>i.path.includes('endpoint')),[]);
 // The shared endpoint gets the same scheme rules as any other endpoint, and no host is refused.
 const sharedAlias=defaultConfig();sharedAlias.browser.endpoint='ws://host.containers.internal:3030/ws';assert.deepEqual(validateConfig(sharedAlias).filter(i=>i.path==='browser.endpoint'),[],'a container-runtime alias is a valid endpoint');
 const wrongScheme=defaultConfig();wrongScheme.browser.endpoint='ftp://example.org/ws';assert.ok(validateConfig(wrongScheme).some(i=>i.path==='browser.endpoint'),'a non-WebSocket scheme is not a Playwright endpoint');
 const bad=defaultConfig();bad.browser.credentialRef='not a ref';assert.ok(validateConfig(bad).some(i=>i.path==='browser.credentialRef'));
});
test('plaintext endpoints are accepted on any host, including container-runtime aliases',()=>{for(const endpoint of ['ws://host.containers.internal:3030/ws','ws://host.docker.internal:3030/ws','ws://100.64.0.10:3030/xhs','ws://example.org/socket']){const shared=defaultConfig();shared.browser.endpoint=endpoint;assert.deepEqual(validateConfig(shared).filter(i=>i.path==='browser.endpoint'),[],`${endpoint} should be accepted as the shared browser endpoint`);const c=config();c.backends.xiaohongshu!.enabled=true;c.backends.xiaohongshu!.mode='browser';c.backends.xiaohongshu!.endpoint=endpoint;assert.deepEqual(validateConfig(c).filter(i=>i.path.endsWith('.endpoint')),[],`${endpoint} should be accepted on a backend`);}});
test('Zhihu case-sensitive GET contract includes timestamp and bearer',async()=>{const c=config();const b=c.backends['zhihu-web']!;b.enabled=true;const response=await runAdapter('zhihu-web',{query:'test',maxResults:30,config:c,backend:b,key:'secret',signal:new AbortController().signal},{signal:new AbortController().signal,retry:c.retry,attemptTimeoutMs:1000,beforeAttempt(){},onAttempt(){},fetch:mock((url,init)=>{const u=new URL(url);assert.equal(u.searchParams.get('Query'),'test');assert.equal(u.searchParams.get('Count'),'20');assert.equal((init.headers as any).Authorization,'Bearer secret');assert.ok((init.headers as any)['X-Request-Timestamp']);return Response.json({Code:0,Data:{Items:[{Title:'test',Url:'https://example.org',ContentText:'text'}]}});})});assert.equal(response.sources[0]!.snippet,'text');});

test('free anonymous tiers are not labelled unavailable, and live evidence is recorded',async()=>{const {catalog}=await import('../src/catalog.js');for(const id of ['exa','anysearch','parallel','you','keenable']){const def=catalog.find(item=>item.id===id)!;assert.equal(def.evidence,'live',`${id} should carry live evidence`);assert.ok(def.modes.some(mode=>mode.mode==='anonymous'&&mode.tier==='free'),`${id} anonymous mode should be a free tier`);}const exa=catalog.find(item=>item.id==='exa')!;assert.equal(exa.modes.find(mode=>mode.mode==='anonymous')!.tier,'free');for(const def of catalog){if(def.status==='unverified')continue;for(const mode of def.modes)assert.notEqual(mode.tier,'unverified',`${def.id}/${mode.mode} must not be tiered as unavailable`);}});

test('a retired backend id in a saved row is pruned instead of blocking load, and new ids are backfilled',async()=>{const {parseConfig}=await import('../src/config.js');const saved:any=defaultConfig();saved.backends.serper={enabled:false,mode:'key',endpoint:'https://google.serper.dev/search',credentialRef:'DSH_SEARCH_SERPER_KEY',timeoutMs:15000,rateLimitPerMinute:0,dailyAttemptLimit:0,options:{}};delete saved.backends.exa;const loaded=parseConfig(saved);assert.equal('serper' in loaded.backends,false);assert.ok(loaded.backends.exa);assert.deepEqual(validateConfig(loaded),[]);});

test('language and region codes are validated and translated per backend',async()=>{const {LANGUAGES,REGIONS,languageFor,regionFor}=await import('../src/locale-map.js');assert.equal(languageFor('brave','zh-Hans'),'zh-hans');assert.equal(languageFor('serper','zh-Hans'),'zh-cn');assert.equal(languageFor('serper','zh-Hant'),'zh-tw');assert.equal(languageFor('searxng','zh-Hans'),'zh-CN');assert.equal(languageFor('you','zh-Hant'),'ZH');assert.equal(languageFor('anysearch','zh-Hans'),'zh');assert.equal(languageFor('keenable','en'),undefined);assert.equal(languageFor('brave','xx'),undefined);assert.equal(regionFor('brave','CN'),'CN');assert.equal(regionFor('serper','CN'),'cn');assert.equal(regionFor('searxng','CN'),undefined);const c=defaultConfig();c.language='xx' as any;assert.ok(validateConfig(c).some(i=>i.path==='language'));const d=defaultConfig();d.region='ZZ' as any;assert.ok(validateConfig(d).some(i=>i.path==='region'));const e=defaultConfig();e.language='zh-Hans';e.region='CN';assert.deepEqual(validateConfig(e),[]);assert.ok(LANGUAGES.includes('zh-Hans')&&REGIONS.includes('CN'));});

test('per-call overrides pick a backend subset and report the ones they had to skip',async()=>{const c=defaultConfig();c.backends.keenable!.enabled=true;c.backends.exa!.enabled=true;c.retry.enabled=false;const urls:string[]=[];const e=new SearchEngine(c,async()=>undefined,mock(url=>{urls.push(url);return Response.json(payload);}));
 const narrowed=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',backends:['exa','not-a-backend']});
 assert.equal(narrowed.outcomes.length,1);assert.equal(narrowed.outcomes[0]!.backend,'exa');assert.match(narrowed.content,/Ignored backends that are not enabled: not-a-backend\./);
 const empty=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',backends:['not-a-backend']});
 assert.equal(empty.outcomes.length,0);assert.match(empty.content,/None of the requested backends are enabled/);});
test('a backend argument is refused out loud when single mode wins',async()=>{const c=config();c.mode='single';c.singleBackend='keenable';c.backends.exa!.enabled=true;const e=new SearchEngine(c,async()=>undefined,mock(()=>Response.json(payload)));
 const r=await e.search({query:'hello'},undefined,undefined,{backend:'exa'});
 assert.deepEqual(r.outcomes.map(outcome=>outcome.backend),['keenable']);assert.match(r.content,/single mode ignores the requested backend selection/);
 const parallel=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',backend:'exa'});
 assert.match(parallel.content,/parallel mode ignores a single backend argument/);});
test('a per-call result bound is enforced and never cached over a different bound',async()=>{const c=defaultConfig();c.backends.searxng!.enabled=true;c.backends.searxng!.endpoint='http://127.0.0.1:8385/search';c.retry.enabled=false;c.cache.enabled=true;c.cache.ttlSeconds=60;const rows=[1,2,3].map(index=>({title:`T${index}`,url:`https://example.org/${index}`,content:`snippet ${index}`}));const e=new SearchEngine(c,async()=>undefined,mock(()=>Response.json({results:rows})));
 const bounded=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',maxResults:2});
 assert.equal(bounded.sources.length,2);assert.equal(bounded.truncated,true);
 await assert.rejects(e.search({query:'hello'},undefined,undefined,{maxResults:99}),/1–50/);});

test('every mode that needs a credential tells the UI what to paste',async()=>{const {catalog}=await import('../src/catalog.js');const shaped=new Set(['x','reddit','tencent-wsa']);
 for(const def of catalog)for(const mode of def.modes){
  if(mode.mode==='anonymous'){assert.equal(mode.credentialShape,undefined,`${def.id}/${mode.mode} takes no credential`);continue;}
  if(shaped.has(def.id))assert.ok(mode.credentialShape,`${def.id}/${mode.mode} must declare the credential shape`);
  if(mode.credentialShape)assert.ok(mode.credentialShape.en&&mode.credentialShape.zh,`${def.id}/${mode.mode} shape needs both languages`);
 }});

test('allBackends plus an exclusion names the set that actually ran',async()=>{const c=defaultConfig();for(const id of['keenable','exa','searxng'])c.backends[id]!.enabled=true;c.backends.searxng!.endpoint='http://127.0.0.1:8385/search';c.retry.enabled=false;const e=new SearchEngine(c,async()=>undefined,mock(()=>new Response('boom',{status:500})));
 const r=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',backends:'all',exclude:['exa','ghost']});
 assert.deepEqual(r.outcomes.map(outcome=>outcome.backend).sort(),['keenable','searxng']);
 assert.match(r.content,/Ignored exclusions for backends that are not enabled: ghost\./);
 assert.match(r.content,/Backends used in this call: .*(keenable|searxng)/);
 const none=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',exclude:['exa']});
 assert.equal(none.outcomes.length,2);
 const mismatch=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',backends:['keenable'],exclude:['nope']});
 assert.match(mismatch.content,/Ignored exclusions for backends that are not enabled: nope\./);});
test('compact returns links without snippets',async()=>{const c=defaultConfig();c.backends.searxng!.enabled=true;c.backends.searxng!.endpoint='http://127.0.0.1:8385/search';c.retry.enabled=false;c.cache.enabled=false;const rows=[1,2].map(index=>({title:`T${index}`,url:`https://example.org/${index}`,content:'x'.repeat(400)}));const e=new SearchEngine(c,async()=>undefined,mock(()=>Response.json({results:rows})));
 const full=await e.search({query:'hello'},undefined,undefined,{mode:'parallel'});
 assert.ok(full.sources[0]!.snippet,);const compact=await e.search({query:'hello'},undefined,undefined,{mode:'parallel',compact:true});
 assert.equal(compact.sources.length,2);assert.equal(compact.sources[0]!.snippet,undefined);assert.equal(compact.sources[0]!.summary,undefined);assert.ok(compact.sources[0]!.url);assert.ok(compact.sources[0]!.title);
 assert.ok(JSON.stringify(compact.sources).length*2<JSON.stringify(full.sources).length*2);});

test('the agent switch is a validated boolean that defaults to on',async()=>{const c=defaultConfig();assert.equal(c.tools.webSearchPlus,true);const off=structuredClone(c)as any;off.tools.webSearchPlus=false;assert.deepEqual(validateConfig(off),[]);const bogus=structuredClone(c)as any;bogus.tools.webSearchPlus='yes';assert.ok(validateConfig(bogus).some(issue=>issue.path==='tools.webSearchPlus'));const unknown=structuredClone(c)as any;unknown.tools.somethingElse=true;assert.ok(validateConfig(unknown).some(issue=>issue.path==='tools.somethingElse'));});

test('a failed backend never leaves undefined keys in tool-visible output',async()=>{const c=config();c.retry.enabled=false;const e=new SearchEngine(c,async()=>undefined,mock(()=>{throw new Error('ECONNRESET');}));const r=await e.search({query:'hello'});
 const roundTrip=JSON.parse(JSON.stringify(r));assert.deepEqual(roundTrip,r,'the result must survive a JSON round trip unchanged');
 assert.equal('status' in r.outcomes[0]!.error! ,false,'an absent status must not be an undefined property');});

test('credentialed modes other than key also receive the stored credential',async()=>{
 const c=defaultConfig();c.backends.x!.enabled=true;c.backends.x!.mode='session';c.retry.enabled=false;
 let resolved=0;
 const missing=new SearchEngine(c,async()=>{resolved++;return undefined;},mock(()=>Response.json({})));
 const failed=(await missing.search({query:'hello'})).outcomes[0]!;
 assert.equal(failed.error!.kind,'configuration');
 assert.ok(failed.error!.message.includes('needs a stored credential'),failed.error!.message);
 const present=new SearchEngine(c,async()=>{resolved++;return JSON.stringify({authToken:'a',ct0:'b'});},mock(()=>Response.json({})));
 const outcome=(await present.search({query:'hello'})).outcomes[0]!;
 assert.equal(resolved,2);
 assert.ok(!(outcome.error?.message??'').includes('needs a stored credential'));
});

test('compact becomes the default from configuration yet stays overridable per call',async()=>{const build=()=>{const c=defaultConfig();c.backends.searxng!.enabled=true;c.backends.searxng!.endpoint='http://127.0.0.1:8385/search';c.retry.enabled=false;c.cache.enabled=false;return c;};
 const rows=[{title:'T',url:'https://example.org/1',content:'a long snippet '.repeat(30)}];
 const compactConfig=build();compactConfig.tools.compactByDefault=true;
 const tight=new SearchEngine(compactConfig,async()=>undefined,mock(()=>Response.json({results:rows})));
 assert.equal((await tight.search({query:'hello'},undefined,undefined,{mode:'parallel'})).sources[0]!.snippet,undefined,'the strategy path honours the saved default');
 assert.ok((await tight.search({query:'hello'},undefined,undefined,{mode:'parallel',compact:false})).sources[0]!.snippet,'an explicit false wins over the saved default');
 const plain=build();plain.tools.compactByDefault=true;
 const provider=new SearchEngine(plain,async()=>undefined,mock(()=>Response.json({results:rows})));
 assert.ok((await provider.search({query:'hello'})).sources[0]!.snippet,'the plain web_search path keeps snippets regardless');});

test('a browser backend owns no credential reference; the endpoint token belongs to the shared browser',async()=>{
  const c=defaultConfig();
  assert.equal(c.backends.xiaohongshu!.credentialRef,'','a browser-only backend does not borrow a key name');
  assert.equal(c.browser.credentialRef,'DSH_SEARCH_BROWSER_TOKEN');
  assert.equal(c.backends.xiaohongshu!.mode,'browser');
  // A backend that also reads over HTTP still needs its own reference.
  assert.match(c.backends.keenable!.credentialRef,/^DSH_SEARCH_KEENABLE_KEY$/);
  // An empty reference is legal only while the backend reads through the browser.
  const keyMode=config();keyMode.backends.keenable!.credentialRef='';assert.ok(validateConfig(keyMode).some(i=>i.path==='backends.keenable.credentialRef'),'key mode cannot run without a reference');
  const browserMode=defaultConfig();browserMode.backends.xiaohongshu!.enabled=true;assert.deepEqual(validateConfig(browserMode).filter(i=>i.path==='backends.xiaohongshu.credentialRef'),[]);
  const legacy=defaultConfig();legacy.backends.xiaohongshu!.credentialRef='DSH_SEARCH_XIAOHONGSHU_KEY';assert.deepEqual(validateConfig(legacy).filter(i=>i.path==='backends.xiaohongshu.credentialRef'),[],'a legacy per-backend reference still validates');
});

test('the shared browser token wins over a backend-level one, which stays a legacy fallback',async()=>{
  const {browserBackends}=await import('../src/adapters.js');
  const original=browserBackends.xiaohongshu!;const seen:string[]=[];
  browserBackends.xiaohongshu={search:async input=>{seen.push(String(input.key??''));return [];}};
  try{
    const stored:Record<string,string>={DSH_SEARCH_BROWSER_TOKEN:'SHARED',DSH_SEARCH_XIAOHONGSHU_KEY:'BACKEND'};
    const c=defaultConfig();c.browser.endpoint='ws://127.0.0.1:3000/ws';c.backends.xiaohongshu!.enabled=true;c.backends.xiaohongshu!.mode='browser';c.backends.xiaohongshu!.credentialRef='DSH_SEARCH_XIAOHONGSHU_KEY';c.retry.enabled=false;
    const engine=new SearchEngine(c,async ref=>stored[ref],mock(()=>Response.json(payload)));
    await engine.search({query:'x'},undefined,'xiaohongshu');
    assert.deepEqual(seen,['SHARED'],'the shared reference is read first');
    delete stored.DSH_SEARCH_BROWSER_TOKEN;
    await engine.search({query:'x'},undefined,'xiaohongshu');
    assert.deepEqual(seen,['SHARED','BACKEND'],'the backend reference covers a token stored before the shared block existed');
    delete stored.DSH_SEARCH_XIAOHONGSHU_KEY;
    await engine.search({query:'x'},undefined,'xiaohongshu');
    assert.deepEqual(seen,['SHARED','BACKEND',''],'a browser read without a token is not blocked');
  }finally{browserBackends.xiaohongshu=original;}
});
