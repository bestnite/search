import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import { SearchError } from './transport.js';
const spec=defineDomain({name:'nite_search_usage',version:1,tables:{attempts:domainTable(z.object({day:z.string(),attempts:z.number().int().nonnegative(),recent:z.array(z.number())}))}});
export async function openUsage(ctx:Context){
  const domain=await ctx.storageDomain.open(spec);const table=domain.table('attempts');let chain:Promise<unknown>=Promise.resolve();
  const reserve=(id:string,mode:string,perMinute:number,daily:number)=>{
    const run=chain.then(async()=>{try{const key=`${id}-${mode}`;const day=new Date().toISOString().slice(0,10);const prior=table.get(key);const attempts=prior?.day===day?prior.attempts:0;const recent=(prior?.recent??[]).filter(t=>t>Date.now()-60000);
      if(daily&&attempts>=daily)throw new SearchError('budget','Local daily attempt cap reached (UTC reset; not provider balance).');
      if(perMinute&&recent.length>=perMinute)throw new SearchError('budget','Local per-minute attempt limit reached.');
      await table.put(key,{day,attempts:attempts+1,recent:[...recent,Date.now()]});return {day,attempts:attempts+1};
    }catch(e){if(e instanceof SearchError)throw e;throw new SearchError('budget','Cannot durably reserve local attempt budget; no request was sent.');}});
    chain=run.catch(()=>{});return run;
  };
  return {reserve,counters:()=>Object.fromEntries([...table.entries()].map(([key,v])=>[key,{attempts:v.attempts,day:v.day}])),close:async()=>{await chain;await domain.close();}};
}
