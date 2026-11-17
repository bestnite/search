import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { WebSearchRequest } from '@deepseek-ai/dsh-web';
import '@deepseek-ai/dsh-config-editor';
import { catalog } from './catalog.js';
import { defaultConfig, parseConfig, validateConfig } from './config.js';
import { revision, SearchEngine } from './engine.js';
import { openUsage } from './usage.js';
import type { SearchConfig, SettingsSnapshot } from './types.js';
export const name='nite-search';
export const inject=['web','credentials','configEditor','connection','tools','storageDomain'];
// Build a complete native Config schema from the same defaults used by the UI.
function schema(value:unknown):any{
  if(Array.isArray(value))return z.array(typeof value[0]==='number'?z.number():z.string()).default(value);
  if(value&&typeof value==='object')return z.object(Object.fromEntries(Object.entries(value).map(([k,v])=>[k,schema(v)]))).default(value);
  if(typeof value==='number')return z.number().default(value);
  if(typeof value==='boolean')return z.boolean().default(value);
  return z.string().default(value as string);
}
export const Config=schema(defaultConfig());
interface FetchRoute {path:string;methods:('GET'|'POST')[];requestBody:'buffered';fetch:(request:Request)=>Promise<Response>}
interface Connection {fetch:{register:(route:FetchRoute)=>()=>Promise<void>}}
interface Tools {register:(definition:{name:string;description:string;parameters:Record<string,unknown>;output:{schema:Record<string,unknown>;render:(args:unknown,value:any)=>{type:'text';text:string}[]};execute:(args:any,exec:{signal:AbortSignal})=>Promise<unknown>})=>()=>void}
export async function apply(ctx:Context,raw:SearchConfig){
  const config=parseConfig(raw);
  const usage=await openUsage(ctx);ctx.effect(()=>()=>usage.close());
  const engine=new SearchEngine(config,async ref=>(await ctx.credentials.resolve(credentialRef(ref)))?.value,fetch,usage.reserve);
  const lifetime=new AbortController();ctx.effect(()=>()=>{lifetime.abort();engine.clearCache();engine.clearDiagnostics();});
  ctx.effect(()=>ctx.web.registerSearchProvider({id:'nite-search',title:'DSH search',description:{en:'Explicit access modes and transparent backend failures.',zh:'固定接入模式，明确报告各后端调用失败。'},available:()=>true,search:(request:WebSearchRequest,signal?:AbortSignal)=>engine.search(request,AbortSignal.any([lifetime.signal,...(signal?[signal]:[])]))}));
  const currentRevision=revision(config);
  async function snapshot():Promise<SettingsSnapshot>{
    const credentials:SettingsSnapshot['credentials']={};for(const d of catalog){const info=await ctx.credentials.describe(credentialRef(config.backends[d.id]!.credentialRef));credentials[d.id]={configured:info.configured,writable:info.writable};}
    let searchProvider:string|undefined;
    try{const row=ctx.configEditor.configuration().find(item=>item.entry.options.id==='web');searchProvider=({...row?.inherited,...row?.override} as {searchProvider?:string}).searchProvider;}catch{/* Diagnostics only: never fail the page over a read. */}
    return {config:structuredClone(config),defaults:defaultConfig(),revision:currentRevision,catalog,active:{...(searchProvider?{searchProvider}:{}),isSelf:searchProvider==='nite-search'},credentials,diagnostics:engine.diagnostics(),counters:Object.fromEntries(catalog.map(d=>[d.id,usage.counters()[`${d.id}-${config.backends[d.id]!.mode}`]??{attempts:0,day:new Date().toISOString().slice(0,10)}]))};
  }
  async function operate(args:any,signal:AbortSignal):Promise<unknown>{
    if(args?.action==='settings')return snapshot();
    if(args?.action==='activate'){
      const web=ctx.configEditor.entries().find(e=>e.options.id==='web');if(!web)throw new Error('Web provider entry is not addressable.');
      await ctx.configEditor.edit(web,current=>({...current,searchProvider:'nite-search',fetchProvider:'http'}));return {selected:'nite-search',fetchProvider:'http'};
    }
    if(args?.action==='save'){
      if(args.expectedRevision!==currentRevision)throw new Error('Configuration revision conflict. Reload before saving.');
      const candidate=parseConfig(args.config);const entry=ctx.fiber.entry;if(!entry)throw new Error('Configuration cannot be saved in this profile.');
      await ctx.configEditor.edit(entry,()=>candidate as unknown as Record<string,unknown>);return {saved:true};
    }
    if(args?.action==='test'){
      if(typeof args.backendId!=='string'||!config.backends[args.backendId]?.enabled)throw new Error('Backend must be saved and enabled before testing.');
      return engine.search({query:args.query},signal,args.backendId);
    }
    if(args?.action==='clear-cache'){engine.clearCache();return {cleared:true};}
    if(args?.action==='clear-diagnostics'){engine.clearDiagnostics();return {cleared:true};}
    if(args?.action==='credential'){
      const b=config.backends[args.backendId];if(!b||args.ref!==b.credentialRef)throw new Error('Save the backend credential reference before editing its value.');
      if(args.remove===true)await ctx.credentials.unset(credentialRef(b.credentialRef));else {if(typeof args.value!=='string'||!args.value.trim()||args.value.length>16384)throw new Error('A nonempty credential is required.');await ctx.credentials.set(credentialRef(b.credentialRef),args.value);}
      engine.clearCache();return {saved:true};
    }
    throw new Error('Unsupported search management action.');
  }
  const connection=ctx.get('connection' as never) as unknown as Connection;
  const route=(path:string,methods:('GET'|'POST')[],handler:(request:Request)=>Promise<unknown>)=>ctx.effect(()=>connection.fetch.register({path:`/api/nite-search/${path}`,methods,requestBody:'buffered',fetch:async request=>{
    try{return Response.json(await handler(request),{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'Search management operation failed. Check configuration, revision, credentials, and enabled state.'},{status:400,headers:{'Cache-Control':'no-store'}});}
  }}));
  const body=async(request:Request)=>{const text=await request.text();if(text.length>262144)throw new Error('Request exceeds size limit.');return JSON.parse(text);};
  route('settings',['GET','POST'],async r=>r.method==='GET'?snapshot():operate({...(await body(r)),action:'save'},r.signal));
  route('action',['POST'],async r=>operate(await body(r),r.signal));
  route('credential',['POST'],async r=>operate({...(await body(r)),action:'credential'},r.signal));
  const tools=ctx.get('tools') as unknown as Tools;
  ctx.effect(()=>tools.register({name:'search_manage',description:'Inspect or configure the DSH search plugin, explicitly test an enabled backend (may incur charges), manage credentials, or clear caches/diagnostics. Configuration uses an expectedRevision from settings. Never enable a paid backend without user authorization. Credential values are never returned.',parameters:{type:'object',properties:{action:{type:'string',enum:['settings','save','test','clear-cache','clear-diagnostics','credential','activate']},config:{type:'object',additionalProperties:true},expectedRevision:{type:'string'},backendId:{type:'string'},query:{type:'string'},ref:{type:'string'},value:{type:'string'},remove:{type:'boolean'}},required:['action']},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:(args,exec)=>operate(args,exec.signal)}));
}
export { defaultConfig, validateConfig };
