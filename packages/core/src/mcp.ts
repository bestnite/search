import { requestText, SearchError, type TransportOptions } from './transport.js';
type Row=Record<string,unknown>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
export async function callMcp(endpoint:string,tool:string,args:Record<string,unknown>,transport:TransportOptions):Promise<Row>{
  const headers:Record<string,string>={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const rpc=async(method:string,params:unknown,id?:number):Promise<Row>=>{
    const text=await requestText(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(id===undefined?{}:{id}),method,params})},method==='tools/call'?transport:{...transport,beforeAttempt:()=>{},onAttempt:()=>{}});
    if(!text.trim()&&id===undefined)return {};
    let packets:unknown[];try{packets=text.trim().startsWith('{')?[JSON.parse(text)]:text.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>{try{return JSON.parse(l.slice(5));}catch{return undefined;}});}catch{throw new SearchError('protocol','MCP returned invalid JSON/SSE.');}
    const packet=packets.find(p=>row(p).id===id);if(!packet||!('result' in row(packet))&&!('error' in row(packet)))throw new SearchError('protocol','MCP response is missing the matching result.');const response=row(packet);if(response.error)throw new SearchError('protocol','MCP server rejected the operation.');return row(response.result);
  };
  // Capture transport session headers without exposing them to the model.
  const originalFetch=transport.fetch??fetch;
  transport={...transport,fetch:(async(url,init)=>{const response=await originalFetch(url,init);const session=response.headers.get('mcp-session-id');if(session)headers['Mcp-Session-Id']=session;return response;})as typeof fetch};
  const initialized=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'dsh-search',version:'0.1.0'}},1);
  if(typeof initialized.protocolVersion!=='string')throw new SearchError('protocol','MCP initialization did not negotiate a protocol version.');headers['MCP-Protocol-Version']=initialized.protocolVersion;
  await rpc('notifications/initialized',{},undefined);
  const list=await rpc('tools/list',{},2);const tools=Array.isArray(list.tools)?list.tools:[];const definition=tools.map(row).find(d=>d.name===tool);
  if(!definition)throw new SearchError('protocol','Configured MCP search tool is not advertised by the provider.');
  const inputSchema=row(definition.inputSchema);if(inputSchema.oneOf||inputSchema.anyOf)throw new SearchError('protocol','MCP tool uses an unsupported composite input schema.');const properties=row(inputSchema.properties);for(const key of Object.keys(args))if(!(key in properties)&&inputSchema.additionalProperties!==true)throw new SearchError('protocol',`MCP tool does not support the configured ${key} parameter.`);
  for(const required of Array.isArray(row(definition.inputSchema).required)?row(definition.inputSchema).required as string[]:[])if(!(required in args))throw new SearchError('protocol','MCP tool requires an unsupported input parameter.');
  const result=await rpc('tools/call',{name:tool,arguments:args},3);if(result.isError)throw new SearchError('protocol','MCP search tool reported failure; check account and quota.');return result;
}
