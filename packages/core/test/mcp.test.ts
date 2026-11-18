import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callMcp } from '../src/mcp.js';
import { defaultConfig } from '../src/config.js';
const response=(id:unknown,result:unknown)=>Response.json({jsonrpc:'2.0',id,result});
const schema={type:'object',properties:{query:{type:'string'},max_results:{type:'number'}},required:['query']};
const options=(fetch:typeof globalThis.fetch,counter={attempts:0})=>({signal:new AbortController().signal,retry:defaultConfig().retry,attemptTimeoutMs:1000,beforeAttempt(){counter.attempts+=1;},onAttempt(){},fetch});

test('MCP handshakes, replays the session header, validates the schema and counts one search attempt',async()=>{
  const methods:string[]=[];const counter={attempts:0};
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));methods.push(body.method);
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:String((body.params as {protocolVersion?:string}).protocolVersion),capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}},{headers:{'mcp-session-id':'SESSION'}});
    assert.equal(new Headers(init?.headers as HeadersInit).get('mcp-session-id'),'SESSION','the session header comes back on every later request');
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    if(body.method==='tools/list')return response(body.id,{tools:[{name:'web_search',inputSchema:schema}]});
    return response(body.id,{structuredContent:{results:[]}});
  }) as unknown as typeof globalThis.fetch;
  const result=await callMcp('https://example.org/mcp','web_search',{query:'hello'},options(fetchImpl,counter));
  assert.deepEqual(result.structuredContent,{results:[]});
  assert.equal(counter.attempts,1,'only tools/call counts as an attempt');
  assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','tools/call']);
});

test('a parameter the tool does not declare fails before any call is sent',async()=>{
  const methods:string[]=[];
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));methods.push(body.method);
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:String((body.params as {protocolVersion?:string}).protocolVersion),capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}});
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    return response(body.id,{tools:[{name:'web_search',inputSchema:schema}]});
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(callMcp('https://example.org/mcp','web_search',{query:'hello',depth:'deep'},options(fetchImpl)),/does not support the configured depth parameter/);
  assert.equal(methods.includes('tools/call'),false,'a rejected configuration spends no request');
});

test('a tool the provider does not advertise is reported by name',async()=>{
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:String((body.params as {protocolVersion?:string}).protocolVersion),capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}});
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    return response(body.id,{tools:[]});
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(callMcp('https://example.org/mcp','web_search',{query:'hello'},options(fetchImpl)),/not advertised by the provider/);
});

test('a tool that reports failure is a protocol error with the account hint',async()=>{
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:String((body.params as {protocolVersion?:string}).protocolVersion),capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}});
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    if(body.method==='tools/list')return response(body.id,{tools:[{name:'web_search',inputSchema:schema}]});
    return response(body.id,{isError:true,content:[{type:'text',text:'quota'}]});
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(callMcp('https://example.org/mcp','web_search',{query:'hello'},options(fetchImpl)),/reported failure; check account and quota/);
});

test('a JSON-RPC error answer is reported as a rejected operation',async()=>{
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));
    if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:String((body.params as {protocolVersion?:string}).protocolVersion),capabilities:{tools:{}},serverInfo:{name:'remote',version:'1'}}});
    if(body.method==='notifications/initialized')return new Response(null,{status:202});
    return Response.json({jsonrpc:'2.0',id:body.id,error:{code:-32602,message:'bad params'}});
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(callMcp('https://example.org/mcp','web_search',{query:'hello'},options(fetchImpl)),/rejected the operation/);
});
