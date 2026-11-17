/**
 * Xiaohongshu page scripts. The site's own webpack HTTP client is the only thing that can make
 * these calls — a plain in-page fetch was refused with 406 — so each script locates that client
 * inside the running page and performs one read. Module ids are never hardcoded: they are found
 * by route literals and the registration call, so a rebuild of the site does not break this.
 */

const PRELUDE = `
const status=(e)=>(e&&e.response&&e.response.status)||0;
const fail=(code,message)=>({ok:false,code,message:String(message===undefined?'':message).slice(0,300)});
let captured=null;
if(!Array.isArray(window.webpackChunkxhs_pc_web)){return fail('NOT_READY','the page has not loaded the site runtime');}
try{
  window.webpackChunkxhs_pc_web.push([['xhs_bridge_'+Date.now()+'_'+Math.random().toString(36).slice(2)],[],(req)=>{captured=req;}]);
}catch(e){return fail('NO_RUNTIME',e&&e.message);}
if(!captured||!captured.m){return fail('NO_RUNTIME','no webpack require was captured');}
let hitId=null,hitSrc='';
for(const key of Object.keys(captured.m)){
  let src='';try{src=String(captured.m[key]);}catch{continue;}
  if(src.indexOf('/api/sns/web/v2/user/me')>=0&&src.indexOf('/api/sns/web/v1/feed')>=0){hitId=key;hitSrc=src;break;}
}
if(!hitId){return fail('NO_CLIENT','no module registers both the identity and feed routes');}
const reg=/registerHttp[^]*?\\}\\(\\w+\\((\\d+)\\)\\.([A-Za-z_$][\\w$]*)\\)\\}/.exec(hitSrc);
if(!reg){return fail('NO_REGISTRATION','the http client registration shape changed');}
let candidate=null;
try{const mod=captured(Number(reg[1]));candidate=mod?mod[reg[2]]:null;}catch(e){return fail('NO_CLIENT',e&&e.message);}
const client=candidate&&typeof candidate.get==='function'?candidate:(candidate&&candidate.default?candidate.default:candidate);
if(!client||typeof client.get!=='function'||typeof client.post!=='function'){return fail('BAD_CLIENT','the captured export has no get/post');}
`;

const wrap = (body: string): string => `async () => {\n${PRELUDE}\ntry{${body}}catch(e){return {ok:false,code:'CALL_FAILED',status:status(e),message:String((e&&e.message)||e).slice(0,300)};}\n}`;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const literal = (value: unknown): string => JSON.stringify(value);

/** Identity probe: is the runtime usable, and is the session signed in? */
export function healthScript(): string {
  return wrap(`const me=await client.get('/api/sns/web/v2/user/me');return {ok:true,guest:!!(me&&me.guest),signedIn:!!(me&&me.nickname)};`);
}

export interface SearchScriptInput { query: string; limit: number; page: number; sort: string }

export function searchScript(input: SearchScriptInput): string {
  return wrap(`
const r=await client.post('/api/sns/web/v2/search/notes',{
  keyword:${literal(input.query)},page:${input.page},page_size:20,sort:${literal(input.sort)},note_type:0,ext_flags:[],image_formats:['jpg','webp','avif'],geo:''
},{baseURL:'https://so.xiaohongshu.com',withCredentials:true,transform:true});
const list=Array.isArray(r&&r.items)?r.items:[];
const items=[];
for(const item of list){
  if(!item||item.modelType!=='note'){continue;}
  const card=item.noteCard||{};const user=card.user||{};const stats=card.interactInfo||{};
  items.push({
    id:String(item.id||''),
    title:${text.name}(card.displayTitle||card.title),
    author:${text.name}(user.nickname||user.nickName),
    authorId:${text.name}(user.userId),
    likes:stats.likedCount||'0',
    url:'https://www.xiaohongshu.com/explore/'+String(item.id||''),
    cover:${text.name}(card.cover&&(card.cover.urlDefault||card.cover.url)),
    xsecToken:${text.name}(item.xsecToken)
  });
  if(items.length>=${input.limit}){break;}
}
return {ok:true,items:items,hasMore:!!(r&&r.hasMore),raw:list.length};`);
}

export function noteScript(input: { id: string; token: string }): string {
  return wrap(`
const feed=await client.post('/api/sns/web/v1/feed',{
  source_note_id:${literal(input.id)},
  image_formats:['jpg','webp','avif'],
  extra:{need_head_cursor:true},
  xsec_token:${literal(input.token)}
});
const first=feed&&Array.isArray(feed.items)?feed.items[0]:null;
const card=first&&first.noteCard?first.noteCard:null;
if(!card){return {ok:false,code:'EMPTY','message':'the feed came back without a note card'};}
const user=card.user||{};const stats=card.interactInfo||{};
return {ok:true,note:{
  id:${literal(input.id)},
  title:${text.name}(card.title||card.displayTitle),
  desc:${text.name}(card.desc),
  author:${text.name}(user.nickname||user.nickName),
  authorId:${text.name}(user.userId),
  likes:stats.likedCount||'0',
  collects:stats.collectedCount||'0',
  comments:stats.commentCount||'0',
  shares:stats.sharedCount||'0',
  publishedAt:${text.name}(card.time||card.lastUpdateTime),
  tags:(card.tagList||[]).map(function(t){return ${text.name}(t&&t.name);}).filter(Boolean).slice(0,20),
  images:(card.imageList||[]).length,
  url:'https://www.xiaohongshu.com/explore/'+${literal(input.id)}
}};`);
}

export function commentsScript(input: { id: string; token: string; cursor: string; limit: number }): string {
  return wrap(`
const page=await client.get('/api/sns/web/v2/comment/page',{params:{
  note_id:${literal(input.id)},cursor:${literal(input.cursor)},top_comment_id:'',image_formats:['jpg','webp','avif'],xsec_token:${literal(input.token)}
}});
const list=Array.isArray(page&&page.comments)?page.comments:[];
const out=[];
for(const c of list){
  if(!c||c.invalid){continue;}
  const u=c.userInfo||{};
  out.push({
    id:String(c.id||''),
    author:${text.name}(u.nickname||u.nickName),
    content:${text.name}(c.content),
    likes:c.likeCount||'0',
    replies:c.subCommentCount||'0',
    ipLocation:${text.name}(c.ipLocation),
    liked:!!c.liked
  });
  if(out.length>=${input.limit}){break;}
}
return {ok:true,comments:out,hasMore:!!(page&&page.hasMore),cursor:${text.name}(page&&page.cursor)};`);
}

/** Set the session cookies inside the page, then prove they work before reporting success. */
export function sessionScript(input: { cookies: string }): string {
  return wrap(`
const pairs=${literal(input.cookies)}.split(';');
let applied=0;
for(const pair of pairs){
  const idx=pair.indexOf('=');
  if(idx<=0){continue;}
  const name=pair.slice(0,idx).trim();
  const value=pair.slice(idx+1).trim();
  if(!name||!value){continue;}
  document.cookie=name+'='+value+'; path=/; domain=.xiaohongshu.com';
  applied++;
}
const me=await client.get('/api/sns/web/v2/user/me');
return {ok:true,applied:applied,guest:!!(me&&me.guest),signedIn:!!(me&&me.nickname)};`);
}
