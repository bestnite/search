/**
 * Page-side probes for the page-driven Xiaohongshu reader.
 *
 * Nothing here calls the site's API. The page does that by itself once it is driven like a person
 * drives it, so these scripts only read what the page already produced: the identity it resolved,
 * the candidates it rendered, and the state it stored for a note and its comments.
 *
 * The page's own state uses camelCase and wraps some values in reactive objects, so every probe
 * unwraps refs before reading. A missing value is reported as `null` rather than as a plausible
 * default: the caller treats "not there yet" and "there and empty" as different answers.
 */

const UNWRAP = `
const unwrap=(value)=>value&&typeof value==='object'&&value.__v_isRef?value.value:value;
const state=window.__INITIAL_STATE__;
const str=(value)=>(typeof value==='string'?value:'');
`;

/**
 * What the page currently knows: how far the identity resolved, and how many results it rendered.
 * Used both to gate a read on a signed-in session and to wait for a result set to settle.
 */
export function stateProbeScript(): string {
  return `() => {
${UNWRAP}
const user=state&&state.user;
const info=unwrap(user&&user.userInfo);
const search=state&&state.search;
const feeds=unwrap(search&&search.feeds);
const cards=document.querySelectorAll('[data-note-id]');
return {
  hasState:!!state,
  guest:info&&typeof info.guest==='boolean'?info.guest:null,
  loggedIn:typeof unwrap(user&&user.loggedIn)==='boolean'?unwrap(user.loggedIn):null,
  hasUserInfo:!!info,
  feedCount:Array.isArray(feeds)?feeds.length:null,
  cardCount:cards.length,
  ready:document.readyState
};
}`;
}

/**
 * The cards a search rendered, as references a caller can choose between.
 *
 * A card carries several links to the same note and some of them hold no text at all, so text is
 * never required. `position` is an ordinal for finding the element again, never a click target, and
 * `obscured` is reported as observed — the click path re-checks it at the moment it acts.
 */
export function candidatesScript(): string {
  return `() => {
const normal=(value)=>(value||'').replace(/\\s+/g,' ').trim();
const visible=(element)=>{
  const box=element.getBoundingClientRect();
  const style=getComputedStyle(element);
  return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';
};
const obscured=(element)=>{
  const box=element.getBoundingClientRect();
  const x=box.x+box.width/2;
  const y=box.y+box.height/2;
  if(x<0||y<0||x>=window.innerWidth||y>=window.innerHeight)return true;
  const top=document.elementFromPoint(x,y);
  return !!top&&!element.contains(top)&&!top.contains(element);
};
const candidates=[];
const cards=[...document.querySelectorAll('[data-note-id]')];
for(let index=0;index<cards.length;index++){
  const card=cards[index];
  const noteId=card.getAttribute('data-note-id')||'';
  if(!noteId)continue;
  let chosen=null;
  for(const link of card.querySelectorAll('a[href]')){
    let url;
    try{url=new URL(link.getAttribute('href'),location.origin);}catch{continue;}
    if(!url.pathname.endsWith('/'+noteId))continue;
    if(!visible(link))continue;
    const label=normal(link.innerText||link.getAttribute('aria-label')||'');
    const role=label?'title':'cover';
    const candidate={noteId,path:url.pathname,label,role,position:index,obscured:obscured(link)};
    // A titled link is the better reference; a cover link is accepted when it is all there is.
    if(!chosen||(!chosen.label&&label))chosen=candidate;
    if(label)break;
  }
  if(chosen)candidates.push(chosen);
}
return candidates;
}`;
}

/** The note the page resolved, projected to the fields the reader returns. */
export function noteDetailScript(noteId: string): string {
  return `() => {
${UNWRAP}
const id=${JSON.stringify(noteId)};
const store=unwrap(state&&state.note);
const detail=unwrap(store&&store.noteDetailMap);
const entry=detail&&detail[id];
const note=unwrap(entry&&entry.note);
if(!note)return {found:false};
const user=unwrap(note.user)||{};
const stats=unwrap(note.interactInfo)||{};
const images=unwrap(note.imageList)||[];
const tags=unwrap(note.tagList)||[];
const count=(value)=>(value===undefined||value===null||value==='')?'0':String(value);
return {
  found:true,
  idMatches:str(note.noteId)===id,
  title:str(note.title),
  desc:str(note.desc),
  author:str(user.nickname||user.nickName),
  authorId:str(user.userId),
  likes:count(stats.likedCount),
  collects:count(stats.collectedCount),
  comments:count(stats.commentCount),
  shares:count(stats.sharedCount),
  publishedAt:str(note.time||note.lastUpdateTime),
  tags:tags.map((tag)=>str(unwrap(tag)&&unwrap(tag).name)).filter(Boolean).slice(0,20),
  imageUrls:images.map((image)=>{
    const item=unwrap(image)||{};
    return str(item.urlDefault||item.urlPre||item.url);
  }).filter(Boolean),
  commentCount:Array.isArray(unwrap(entry.comments)&&unwrap(entry.comments).list)?unwrap(entry.comments).list.length:null,
  commentsLoaded:!!(unwrap(entry.comments)&&unwrap(entry.comments).firstRequestFinish),
  commentsHasMore:!!(unwrap(entry.comments)&&unwrap(entry.comments).hasMore),
  commentsCursor:str(unwrap(entry.comments)&&unwrap(entry.comments).cursor)
};
}`;
}

/** One page of comments as the page stored it, projected to what the reader returns. */
export function commentsStateScript(noteId: string): string {
  return `() => {
${UNWRAP}
const id=${JSON.stringify(noteId)};
const store=unwrap(state&&state.note);
const detail=unwrap(store&&store.noteDetailMap);
const entry=detail&&detail[id];
const comments=unwrap(entry&&entry.comments);
const list=comments&&Array.isArray(unwrap(comments).list)?unwrap(comments).list:[];
const out=[];
for(const raw of list){
  const comment=unwrap(raw);
  if(!comment||unwrap(comment).invalid)continue;
  const user=unwrap(comment.userInfo)||{};
  out.push({
    id:str(unwrap(comment).id),
    author:str(user.nickname||user.nickName),
    content:str(unwrap(comment).content),
    likes:(unwrap(comment).likeCount===undefined||unwrap(comment).likeCount===null)?'0':String(unwrap(comment).likeCount),
    replies:(unwrap(comment).subCommentCount===undefined||unwrap(comment).subCommentCount===null)?'0':String(unwrap(comment).subCommentCount),
    ipLocation:str(unwrap(comment).ipLocation),
    liked:!!unwrap(comment).liked
  });
}
return {
  comments:out,
  hasMore:!!(comments&&unwrap(comments).hasMore),
  cursor:str(comments&&unwrap(comments).cursor),
  loaded:!!(comments&&unwrap(comments).firstRequestFinish),
  loading:!!(comments&&unwrap(comments).loading)
};
}`;
}

/** Whether a candidate is still present and clickable right now, checked just before acting. */
export function candidateCheckScript(noteId: string, path: string): string {
  return `() => {
const normal=(value)=>(value||'').replace(/\\s+/g,' ').trim();
const id=${JSON.stringify(noteId)};
const want=${JSON.stringify(path)};
const box=(element)=>{
  const rect=element.getBoundingClientRect();
  const style=getComputedStyle(element);
  return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';
};
const cards=[...document.querySelectorAll('[data-note-id]')];
for(const card of cards){
  if(card.getAttribute('data-note-id')!==id)continue;
  for(const link of card.querySelectorAll('a[href]')){
    let url;
    try{url=new URL(link.getAttribute('href'),location.origin);}catch{continue;}
    if(url.pathname!==want)continue;
    if(!box(link))continue;
    const rect=link.getBoundingClientRect();
    const x=rect.x+rect.width/2;
    const y=rect.y+rect.height/2;
    const top=document.elementFromPoint(x,y);
    const clear=!!top&&(link.contains(top)||top.contains(link));
    return {found:true,clickable:clear,present:true};
  }
}
return {found:false,clickable:false,present:false};
}`;
}

/** The query string of a search result page, built here so the caller never assembles URLs. */
export function searchPath(query: string): string {
  return `/search_result?keyword=${encodeURIComponent(query)}`;
}
