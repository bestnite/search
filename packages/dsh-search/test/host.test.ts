import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config, createPlugin, defaultConfig } from '../src/index.js';
import { catalog, revision } from '@nite07/search-core';
/** Every save in this file uses an injected transport; no test opens a browser socket. */
const apply = createPlugin({ browserConnect: async () => ({ newContext: async () => ({ close: async () => undefined }), close: async () => undefined }) });
function harness(){const routes=new Map<string,any>();const definitions:Record<string,any>={};let stored:any;const secrets=new Map<string,string>();const records=new Map();const table={get:(k:string)=>records.get(k),entries:()=>records.entries(),put:async(k:string,v:any)=>{records.set(k,v);}};const ctx:any={fiber:{entry:{id:'test'}},effect(fn:any){return fn();},web:{registerSearchProvider(){return ()=>{};}},credentials:{resolve:async(ref:string)=>secrets.has(ref)?{value:secrets.get(ref)}:undefined,describe:async(ref:string)=>({configured:secrets.has(ref),writable:true}),set:async(ref:string,value:string)=>{secrets.set(ref,value);},unset:async(ref:string)=>{secrets.delete(ref);}},configEditor:{edit:async(_entry:any,fn:any)=>{stored=fn({});},configuration:()=>[{entry:{options:{id:'web'}},inherited:{},override:{searchProvider:'nite-search',fetchProvider:'http'}}]},storageDomain:{open:async()=>({table:()=>table,close:async()=>{}})},get(name:string){if(name==='connection')return {fetch:{register:(r:any)=>{routes.set(r.path,r);return async()=>{};}}};if(name==='tools')return {register:(d:any)=>{definitions[d.name]=d;return ()=>{};}};}};return {ctx,routes,secrets,get tool(){return (name:string)=>definitions[name];},get stored(){return stored;}};}
test('native DSH Config supplies exact shared defaults',()=>assert.deepEqual(Config({}),defaultConfig()));
test('Host UI route and Agent tool share config save/read and credential operations',async()=>{const h=harness();const c=defaultConfig();await apply(h.ctx,c);const snapshot=await h.tool('search_manage')!.execute({action:'settings'},{signal:new AbortController().signal});assert.deepEqual(snapshot.config,c);assert.equal(snapshot.revision,revision(c));assert.deepEqual(snapshot.active,{searchProvider:'nite-search',isSelf:true});const route=h.routes.get('/api/nite-search/settings');assert.deepEqual((await (await route.fetch(new Request('https://localhost/api/nite-search/settings'))).json()).config,c);
 const next=structuredClone(c);next.maxResults=12;await h.tool('search_manage')!.execute({action:'save',config:next,expectedRevision:snapshot.revision},{signal:new AbortController().signal});assert.deepEqual(h.stored,next);
 await assert.rejects(h.tool('search_manage')!.execute({action:'save',config:next,expectedRevision:'stale'},{signal:new AbortController().signal}),/revision conflict/);
 await h.tool('search_manage')!.execute({action:'credential',backendId:'keenable',value:'PRIVATE_KEY'},{signal:new AbortController().signal});const after=await h.tool('search_manage')!.execute({action:'settings'},{signal:new AbortController().signal});assert.equal(after.credentials.keenable.configured,true);assert.ok(!JSON.stringify(after).includes('PRIVATE_KEY'));await h.tool('search_manage')!.execute({action:'credential',backendId:'keenable',remove:true},{signal:new AbortController().signal});assert.equal(h.secrets.size,0);
 await assert.rejects(h.tool('search_manage')!.execute({action:'credential',backendId:'keenable',ref:'ARBITRARY_SECRET',value:'a'},{signal:new AbortController().signal}),/cannot be configured/);
 await assert.rejects(h.tool('search_manage')!.execute({action:'credential',backendId:'nope',value:'a'},{signal:new AbortController().signal}),/Unknown backend/);
});
test('every config scalar and array has an editable client field or generated backend option',async()=>{const {readFile}=await import('node:fs/promises');const client=await readFile(new URL('../src/client.tsx',import.meta.url),'utf8');const defaults=defaultConfig();
 // Paths are declared either as quoted literals in a fields()/section() array or, for backend rows, as a `${base}.x` template.
 const covered=(path:string)=>{if(path.startsWith('backends.')){const tail=path.split('.').slice(2).join('.');return client.includes('`${base}.'+tail+'`');}return client.includes(`'${path}'`);};
 function visit(v:any,path:string){if(path==='backends')return; if(v&&typeof v==='object'&&!Array.isArray(v)){for(const[k,x]of Object.entries(v))visit(x,path?`${path}.${k}`:k);}else assert.ok(covered(path),`Missing form field ${path}`);}visit(defaults,'');
 // Structured sub-records have their own editors rather than one field per leaf: the search options
 // render per catalog entry, and the fetch operation has its own panel on the Fetch tab.
 for(const key of Object.keys(defaults.backends.keenable!)){if(key==='options'||key==='fetch')continue;assert.ok(covered(`backends.keenable.${key}`),`Missing backend field ${key}`);}
 assert.ok(client.includes('def.options.map(option => field('));
 for(const leaf of ['fetch.mode','fetch.endpoint','fetch.timeoutMs','fetch.options.']){assert.ok(client.includes(leaf),`the fetch settings editor renders ${leaf}`);}
 for(const path of ['pageFetch.overallTimeoutMs','pageFetch.allowPrivateNetworks','pageFetch.browser.context','panel-fetch']){assert.ok(client.includes(path),`the Fetch tab renders ${path}`);}
 // The retired delegated switch must not come back as a control: enabling the route is the decision.
 assert.equal(client.includes('allowDelegatedFetching'), false, 'no delegated-fetching checkbox remains');
});

test('the shared browser per-site cap is a schema default, an editable field with its own help',async()=>{
 const {readFile}=await import('node:fs/promises');const defaults=defaultConfig();
 assert.equal(defaults.browser.maxConcurrentReads,2);
 assert.equal(Config({}).browser.maxConcurrentReads,2,'the host schema carries the new default');
 const client=await readFile(new URL('../src/client.tsx',import.meta.url),'utf8');
 assert.match(client,/fields\(\['browser\.endpoint', 'browser\.statePath', 'browser\.timeoutMs', 'browser\.maxConcurrentReads'\]/,'the shared browser section renders the new field');
 assert.match(client,/'browser\.maxConcurrentReads': \{ type: 'number' \}/);
 assert.match(client,/'browser\.maxConcurrentReads': \[MIN_MAX_CONCURRENT_READS, MAX_CONCURRENT_READS\]/);
 for(const lang of ['en','zh']){
  const locale=JSON.parse(await readFile(new URL(`../locale/${lang}.json`,import.meta.url),'utf8'));
  for(const key of ['field.browser.maxConcurrentReads','help.browser.maxConcurrentReads']){
   assert.equal(typeof locale[key],'string',`${lang} supplies ${key}`);
   assert.ok(locale[key].trim(),`${lang} supplies non-empty ${key}`);
  }
 }
});

test('a non-default per-site browser cap survives save and reload',async()=>{
 const h=harness();await apply(h.ctx,defaultConfig());const signal=new AbortController().signal;
 const snapshot=await h.tool('search_manage')!.execute({action:'settings'},{signal});
 const next=structuredClone(snapshot.config);next.browser.maxConcurrentReads=5;
 await h.tool('search_manage')!.execute({action:'save',config:next,expectedRevision:snapshot.revision},{signal});
 assert.equal((h.stored as any).browser.maxConcurrentReads,5,'the saved configuration keeps the chosen cap');
 const {parseConfig}=await import('@nite07/search-core');
 assert.equal(parseConfig(h.stored).browser.maxConcurrentReads,5,'a reload keeps it instead of restoring the default');
});

test('Reddit is an opt-in backend with two explicit modes and its own comment tool',async()=>{const {catalog}=await import('@nite07/search-core');const reddit=catalog.find(item=>item.id==='reddit')!;assert.deepEqual(reddit.modes.map(m=>m.mode).sort(),['anonymous','oauth']);assert.ok(reddit.modes.every(m=>m.tier!=='unverified'));const h=harness();await apply(h.ctx,defaultConfig());const tool=h.tool('reddit_thread');assert.ok(tool,'reddit_thread should be registered');const props=Object.keys((tool as any).parameters.properties);for(const key of['url','postId','sort','limit','depth'])assert.ok(props.includes(key),`missing ${key}`);assert.match(String((tool as any).description),/untrusted/i);});

test('X conversations have their own tool with a bounded schema',async()=>{const h=harness();await apply(h.ctx,defaultConfig());const tool=h.tool('x_thread');assert.ok(tool,'x_thread should be registered');const props=(tool as any).parameters.properties;for(const key of['url','postId','limit','depth'])assert.ok(key in props,`missing ${key}`);assert.equal(props.limit.maximum,200);assert.equal(props.depth.maximum,8);assert.match(String((tool as any).description),/untrusted/i);assert.match(String((tool as any).description),/session mode/);});

test('web_search_plus exposes per-call strategy without touching saved config',async()=>{const h=harness();const c=defaultConfig();await apply(h.ctx,c);const tool=h.tool('web_search_plus');assert.ok(tool,'web_search_plus should be registered');const props=(tool as any).parameters.properties;for(const key of['query','backends','allBackends','exclude','compact','maxResults'])assert.ok(key in props,`missing ${key}`);assert.equal(props.mode,undefined,'the backends array is the strategy; there is no mode argument');assert.equal(props.backend,undefined,'a single backend is backends:["id"], not its own argument');assert.deepEqual((tool as any).parameters.required,['query']);assert.deepEqual(h.stored,undefined,'registration must not write configuration');});

test('web_search_plus disappears when the agent switch is off',async()=>{const withTool=harness();await apply(withTool.ctx,defaultConfig());assert.ok(withTool.tool('web_search_plus'));const c=defaultConfig();c.tools.webSearchPlus=false;const without=harness();await apply(without.ctx,c);assert.equal(without.tool('web_search_plus'),undefined,'the tool must not be registered at all');assert.ok(without.tool('search_manage'),'other tools stay registered');});

test('the note tool explains what is missing before it touches the browser',async()=>{const h=harness();const c=defaultConfig();await apply(h.ctx,c);const tool=h.tool('xiaohongshu_note');assert.ok(tool,'the note tool is registered');
 const signal=new AbortController().signal;
 await assert.rejects(tool.execute({url:'https://www.xiaohongshu.com/explore/abc'},{signal}),/disabled/);
 const enabled=defaultConfig();enabled.backends.xiaohongshu!.enabled=true;const h2=harness();await apply(h2.ctx,enabled);
 await assert.rejects(h2.tool('xiaohongshu_note')!.execute({},{signal}),/Pass url .* or id/);
});

test('a browser endpoint behind a container runtime alias survives save and read-back',async()=>{const h=harness();await apply(h.ctx,defaultConfig());const endpoint='ws://host.containers.internal:3030/ws';
 const next=defaultConfig();next.browser.endpoint=endpoint;next.backends.xiaohongshu!.enabled=true;next.backends.xiaohongshu!.mode='browser';next.backends.xiaohongshu!.endpoint='';
 const snapshot=await h.tool('search_manage')!.execute({action:'settings'},{signal:new AbortController().signal});
 await h.tool('search_manage')!.execute({action:'save',config:next,expectedRevision:snapshot.revision},{signal:new AbortController().signal});
 assert.equal((h.stored as any).browser.endpoint,endpoint,'the shared endpoint is kept as typed');assert.equal((h.stored as any).backends.xiaohongshu.endpoint,'','a browser backend inherits it');assert.equal('credentialRef' in h.stored.backends.xiaohongshu,false);
});

test('the endpoint token is stored once on the shared browser reference',async()=>{const h=harness();await apply(h.ctx,defaultConfig());const signal=new AbortController().signal;
 const first=await h.tool('search_manage')!.execute({action:'settings'},{signal});
 assert.deepEqual(first.browser,{credentialConfigured:false,writable:true},'the page starts with no endpoint token');
 // The caller selects a scope, never a storage name.
 await h.tool('search_manage')!.execute({action:'credential',scope:'browser',value:'ENDPOINT_TOKEN'},{signal});
 const second=await h.tool('search_manage')!.execute({action:'settings'},{signal});
 assert.equal(second.browser.credentialConfigured,true);
 assert.equal(second.credentials.xiaohongshu.configured,false,'the backend row reports no credential of its own');
 assert.ok(!JSON.stringify(second).includes('ENDPOINT_TOKEN'),'a stored token is never echoed back');
 await h.tool('search_manage')!.execute({action:'credential',scope:'browser',remove:true},{signal});
 assert.equal((await h.tool('search_manage')!.execute({action:'settings'},{signal})).browser.credentialConfigured,false);
});

test('saved references cannot redirect credential lookups or writes',async()=>{
 const h=harness();h.secrets.set('ARBITRARY_SECRET','UNRELATED');h.secrets.set('DSH_SEARCH_BROWSER_TOKEN','BROWSER');
 const saved:any=defaultConfig();saved.browser.credentialRef='ARBITRARY_SECRET';saved.backends.keenable.credentialRef='ARBITRARY_SECRET';
 await apply(h.ctx,saved);const signal=new AbortController().signal;
 const snapshot=await h.tool('search_manage')!.execute({action:'settings'},{signal});
 assert.equal(snapshot.browser.credentialConfigured,true);
 assert.equal(snapshot.credentials.keenable.configured,false);
 assert.equal('credentialRef' in snapshot.config.browser,false);
 assert.equal('credentialRef' in snapshot.config.backends.keenable,false);
 await h.tool('search_manage')!.execute({action:'credential',backendId:'keenable',value:'FIXED_KEY'},{signal});
 assert.equal(h.secrets.get('DSH_SEARCH_KEENABLE_KEY'),'FIXED_KEY');assert.equal(h.secrets.get('ARBITRARY_SECRET'),'UNRELATED');
 await assert.rejects(h.tool('search_manage')!.execute({action:'credential',scope:'browser',ref:'ARBITRARY_SECRET',remove:true},{signal}),/cannot be configured/);
 await assert.rejects(h.tool('search_manage')!.execute({action:'credential',backendId:'xiaohongshu',value:'x'},{signal}),/browser credential scope/);
 assert.equal(h.secrets.get('ARBITRARY_SECRET'),'UNRELATED');
 const props=h.tool('search_manage').parameters.properties;assert.equal('ref' in props,false);assert.deepEqual(props.scope.enum,['browser']);
});

test('the client exposes token values without credential-name controls or explanations',async()=>{
 const {readFile}=await import('node:fs/promises');const client=await readFile(new URL('../src/client.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(client,/credentialRef|browserTokenStoredAt|browserTokenRefAdvanced|browserOwnToken/);
 assert.match(client,/scope: 'browser'/);assert.match(client,/secret-browser/);
 for(const lang of ['en','zh']){const locale=JSON.parse(await readFile(new URL(`../locale/${lang}.json`,import.meta.url),'utf8'));assert.ok(!Object.keys(locale).some(key=>/credentialRef|browserTokenStoredAt|browserTokenRefAdvanced/i.test(key)));}
});

test('backend_status reports what is enabled without returning the configuration',async()=>{
 const h=harness();const c=defaultConfig();
 c.backends.keenable!.enabled=true;c.backends.brave!.enabled=true;c.backends.xiaohongshu!.enabled=true;c.browser.endpoint='';
 await apply(h.ctx,c);
 const tool=h.tool('backend_status');assert.ok(tool,'backend_status should be registered');
 const signal=new AbortController().signal;
 const status:any=await tool!.execute({},{signal});
 assert.deepEqual(status.enabled.map((row:any)=>row.id).sort(),['brave','keenable','xiaohongshu']);
 assert.equal(status.enabled.find((row:any)=>row.id==='brave').credential,'missing');
 assert.equal(status.enabled.find((row:any)=>row.id==='keenable').credential,'not-required');
 assert.equal(status.available,catalog.length-3);
 assert.equal(status.provider.isSelf,true);
 assert.ok(status.problems.some((problem:string)=>/brave/.test(problem)),'a missing credential is reported as a problem');
 assert.ok(status.problems.some((problem:string)=>/xiaohongshu/.test(problem)),'a browser backend without a stored endpoint token is reported');
 assert.match(String(status.text),/3 of 24|3 of/);
 const serialized=JSON.stringify(status);
 assert.ok(!serialized.includes('"config":'),'the configuration is not echoed back');
 assert.ok(!serialized.includes('endpoint":"https://api.keenable.ai'),'backend endpoints are not dumped');
 const detail:any=await tool!.execute({backend:'brave'},{signal});
 assert.equal(detail.backend.id,'brave');
 assert.ok(detail.backend.modes.length>=1);
 assert.equal(detail.credential,'missing');
 assert.equal(detail.current.enabled,true);
 assert.match(String(detail.text),/Brave/);
 await assert.rejects(tool!.execute({backend:'nope'},{signal}),/Unknown backend id/);
});

test('backend_status counts a stored credential as present and never resolves its value',async()=>{
 const h=harness();const c=defaultConfig();
 c.backends.brave!.enabled=true;
 await apply(h.ctx,c);
 await h.tool('search_manage')!.execute({action:'credential',backendId:'brave',value:'BRAVE-SECRET'},{signal:new AbortController().signal});
 const status:any=await h.tool('backend_status')!.execute({},{signal:new AbortController().signal});
 assert.equal(status.enabled.find((row:any)=>row.id==='brave').credential,'present');
 assert.ok(!status.problems.some((problem:string)=>/brave/.test(problem)));
 assert.ok(!JSON.stringify(status).includes('BRAVE-SECRET'));
});
