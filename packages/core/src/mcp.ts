import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { abortError, fetchWithPolicy, SearchError, type TransportOptions } from './transport.js';

type Row=Record<string,unknown>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};

/**
 * The anonymous MCP endpoints of exa, parallel and you. The wire protocol belongs to
 * `@modelcontextprotocol/client`: it negotiates the revision, carries `Mcp-Session-Id`, and parses
 * both JSON and SSE responses. What stays here is only what this project owns — which tool to call,
 * and a readable failure instead of a raw transport exception.
 */
export async function callMcp(
  endpoint:string,
  tool:string,
  args:Record<string,unknown>,
  transport:TransportOptions,
  observe?:{
    onStatus?:(status:number)=>void;
    /** Test/embedding seam for the HTTP exchange; production leaves it out. */
    fetcher?:typeof fetch;
    /** A page-fetch caller reads a tool-level error itself instead of losing it in a throw. */
    returnErrorResult?:boolean;
  },
):Promise<Row>{
  const client=new Client({name:'dsh-search',version:'0.1.0'},{capabilities:{}});
  // Only the search itself counts as an attempt, as before: the handshake is overhead, not a try.
  const counting=(init:RequestInit|undefined):TransportOptions=>{
    const body=typeof init?.body==='string'?init.body:'';
    return body.includes('"tools/call"')?transport:{...transport,beforeAttempt:()=>{},onAttempt:()=>{}};
  };
  const observeStatus=(response:Response):Response=>{observe?.onStatus?.(response.status);return response;};
  const session=new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch:async(input,init)=>{
      const options=observe?.fetcher?{...counting(init),fetch:observe.fetcher}:counting(init);
      try{return observeStatus(await fetchWithPolicy(String(input),init??{},options));}
      catch(error){if(error instanceof SearchError&&error.status!==undefined)observe?.onStatus?.(error.status);throw error;}
    },
  });
  try{
    await client.connect(session);
    const advertised=await client.listTools();
    const definition=advertised.tools.find(candidate=>candidate.name===tool);
    if(!definition)throw new SearchError('protocol','Configured MCP search tool is not advertised by the provider.');
    validateArguments(row(definition.inputSchema),args);
    const result=await client.callTool({name:tool,arguments:args},{signal:transport.signal});
    // Search keeps its historical contract: a tool-level error is a protocol failure. A page fetch
    // needs the structured error itself, because only that response can name a provider code.
    if(result.isError&&observe?.returnErrorResult!==true)throw new SearchError('protocol','MCP search tool reported failure; check account and quota.');
    return row(result);
  }catch(caught){
    throw asSearchError(caught,transport);
  }finally{
    await Promise.allSettled([client.close(),session.close()]);
  }
}
/** Reject a configuration the tool cannot accept before spending a request on it. */
function validateArguments(schema:Row,args:Record<string,unknown>):void{
  if(schema.oneOf||schema.anyOf)throw new SearchError('protocol','MCP tool uses an unsupported composite input schema.');
  const properties=row(schema.properties);
  for(const key of Object.keys(args))if(!(key in properties)&&schema.additionalProperties!==true)throw new SearchError('protocol',`MCP tool does not support the configured ${key} parameter.`);
  for(const required of Array.isArray(schema.required)?schema.required as string[]:[])if(!(required in args))throw new SearchError('protocol','MCP tool requires an unsupported input parameter.');
}
/** Transport failures keep their kind; protocol failures get the wording this project already used. */
function asSearchError(caught:unknown,transport:TransportOptions):SearchError{
  const original=findSearchError(caught);
  if(original)return original;
  if(transport.signal.aborted)return abortError(transport.signal);
  const carried=caught as {code?:unknown;message?:unknown}|null;
  const message=typeof carried?.message==='string'?carried.message:'';
  if(typeof carried?.code==='number')return new SearchError('protocol','MCP server rejected the operation.');
  if(/invalid json|unexpected token|json parse|parse error/i.test(message))return new SearchError('protocol','MCP returned invalid JSON/SSE.');
  if(/http\s*\d{3}|unexpected status|bad status|non-2\d\d/i.test(message))return new SearchError('protocol','MCP server rejected the operation.');
  return new SearchError('protocol','MCP response is missing the matching result.');
}
/** The SDK wraps what the injected fetch throws; the original kind must survive the wrapping. */
function findSearchError(caught:unknown):SearchError|undefined{
  let current:unknown=caught;
  for(let depth=0;current&&depth<6;depth+=1){
    if(current instanceof SearchError)return current;
    current=(current as {cause?:unknown}).cause;
  }
  return undefined;
}
