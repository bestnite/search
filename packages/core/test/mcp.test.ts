import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcp } from '../src/mcp.js';
import { defaultConfig } from '../src/config.js';
import { SearchEngine } from '../src/engine.js';
const response=(id:unknown,result:unknown)=>Response.json({jsonrpc:'2.0',id,result});
test('MCP initializes, preserves session headers, discovers schema and counts search attempts only',async()=>{let attempts=0;const methods:string[]=[];const signal=new AbortController().signal;
 const result=await callMcp('https://example.org/mcp','web_search',{query:'hello'},{signal,retry:defaultConfig().retry,attemptTimeoutMs:1000,beforeAttempt(){attempts++;},onAttempt(){},fetch:(async(_url,init)=>{const body=JSON.parse(String(init?.body));methods.push(body.method);if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26'}},{headers:{'mcp-session-id':'SESSION'}});assert.equal((init?.headers as any)['Mcp-Session-Id'],'SESSION');if(body.method==='notifications/initialized')return new Response(null,{status:202});if(body.method==='tools/list')return response(body.id,{tools:[{name:'web_search',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}}]});return response(body.id,{structuredContent:{results:[]}});})as typeof fetch});assert.ok(result.structuredContent);assert.equal(attempts,1);assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','tools/call']);});
test('missing matching RPC result is a protocol error',async()=>{await assert.rejects(callMcp('https://example.org','web_search',{}, {signal:new AbortController().signal,retry:defaultConfig().retry,attemptTimeoutMs:1000,beforeAttempt(){},onAttempt(){},fetch:(async()=>response(999,{}))as typeof fetch}),/matching result/);});
test('You MCP nested results.web JSON is recognized',async()=>{const c=defaultConfig();c.backends.you!.enabled=true;c.safeSearch=false;const engine=new SearchEngine(c,async()=>undefined,(async(_url,init)=>{const b=JSON.parse(String(init?.body));if(b.method==='initialize')return response(b.id,{protocolVersion:'2025-03-26'});if(b.method==='notifications/initialized')return new Response(null,{status:202});if(b.method==='tools/list')return response(b.id,{tools:[{name:'you-search',inputSchema:{type:'object',properties:{query:{type:'string'},count:{type:'number'}}}}]});return response(b.id,{content:[{type:'text',text:JSON.stringify({results:{web:[{title:'test',url:'https://example.org',snippet:'text'}]}})}]});})as typeof fetch);const r=await engine.search({query:'hello'});assert.equal(r.sources.length,1);assert.equal(r.outcomes[0]!.attempts,1);});

test('anonymous MCP results keep a body the server names differently',async()=>{
 const c=defaultConfig();c.backends.exa!.enabled=true;c.backends.parallel!.enabled=true;c.backends.you!.enabled=true;
 const engine=new SearchEngine(c,async()=>undefined,(async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(body.method==='initialize')return response(body.id,{protocolVersion:'2025-03-26'});
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(body.method==='tools/list')return response(body.id,{tools:[{name:'web_search_exa',inputSchema:{type:'object',properties:{query:{type:'string'},objective:{type:'string'},numResults:{type:'number'}}}},{name:'web_search',inputSchema:{type:'object',properties:{objective:{type:'string'},search_queries:{type:'array',items:{type:'string'}}}}},{name:'you-search',inputSchema:{type:'object',properties:{query:{type:'string'},count:{type:'number'}}}}]});
  if(body.params.name==='web_search_exa')return response(body.id,{structuredContent:{results:[{title:'Exa',url:'https://exa.example/a',text:'page text'}]}});
  if(body.params.name==='web_search')return response(body.id,{structuredContent:{results:[{title:'Parallel',url:'https://parallel.example/b',excerpts:['first','second']}]}});
  return response(body.id,{structuredContent:{results:[{title:'You',url:'https://you.example/c',description:'described',page_age:'2026-01-02T00:00:00Z'}]}});
 })as typeof fetch);
 const one=async(id:string)=>{const result=await engine.search({query:'hello'},new AbortController().signal,id);return result.sources[0]!;};
 assert.equal((await one('exa')).snippet,'page text');
 assert.equal((await one('parallel')).snippet,'first\nsecond');
 const you=await one('you');assert.equal(you.snippet,'described');assert.equal(you.publishedAt,'2026-01-02T00:00:00Z');
});
