# Xiaohongshu page-driven reads

Design for replacing the per-call interface invocation with real page operations. Status: proposed,
not implemented. Nothing here is committed behaviour yet.

## Why

Today every Xiaohongshu read is a script run on a page that already sits on the site: the site's own
webpack HTTP client is located at runtime and asked for one endpoint. The page is not touched — no
navigation, no click, no scroll.

The alternative drives what a person drives: an address with the query in it, a real card click, a
real scroll over the comment list. Requests are then produced by the site itself, with the search
context it minted, instead of being constructed by us.

This is risk reduction, not risk elimination. The platform's scoring is opaque and changes. The goal
is to send fewer anomalous signals and to fail visibly when the page path breaks, rather than to be
permanently safe.

## Non-goals

- No pacing, delay, dwell-time or session-length shaping. Simulated human rhythm is not adopted: it is
  unverifiable against the real model and adds a new fingerprint of its own.
- No synthetic activity. No scrolling or clicking that serves no read the caller actually asked for.
- No fabricated analytics. Requests the page emits on its own are kept; none are manufactured.
- No change to the browser image, VNC sign-in or `statePath` handling in this work.

Bringing the image URL leak under control **is** in scope; see [Media](#media).

## Current shape, and what it cannot carry

One connection, one self-owned non-persistent context, one page, several concurrent `evaluate`
transactions. `ensureOnSite` runs once per page generation and then the page is reused as-is.

That works for scripts, because each script returns its own value. It cannot carry navigation: two
tasks driving the same page would destroy each other's document, cross their response listeners, and
read each other's state.

## Architecture: a tab transaction

```text
lease (one admission slot; site-wide cap unchanged)
  ├─ acquire exclusive ownership of a tab
  ├─ arm the response collector for this operation's predicates
  ├─ perform the operation (open address / click a candidate / scroll)
  ├─ wait for the completion condition
  ├─ project the payload, verify its shape
  └─ finally: disarm collectors, settle the tab, release the slot
```

Rules:

- The admission cap keeps its current meaning: it bounds **active leases**, not tabs. Two leases may
  exist; each owns a distinct tab. A tab never hosts two operations.
- Settling a tab has two outcomes. A tab that still holds usable search content is **returned to a
  small idle pool** with its content generation stamped; a tab that failed, was cancelled, or timed
  out is closed. Only the first outcome keeps candidate references alive.
- Pooled tabs are not leases and do not consume the cap. They are closed when the session idles out,
  so a pooled tab lives at most one idle window (five minutes by default).
- Nothing outside the lease touches a pooled or leased tab. `target()` and an escaped reader are not
  an escape hatch into one.
- A closed tab is rebuilt for that task only. An expired sign-in or a lost connection still
  invalidates the whole context generation, after every tab of that generation has finished.
- A lease that fails, is cancelled or times out releases its tab and its slot in `finally`. No
  half-open collection survives a failure.
- Two tabs share one context, so cookies and localStorage are shared. Tab isolation is document and
  listener isolation only; it is not identity isolation.

Inherited unchanged: `statePolicy: 'read-only'`, no replay of a failed read, stale-generation drain,
the single total budget for `close()`, and idle release only when no lease is active or queued.

## Operation completion conditions

A title being present is not completion. Each operation declares what "done" means, and a condition
that is not met within the budget fails the task rather than returning whatever is on the page.

| Operation | Done when |
| --- | --- |
| search | the search response for this query has arrived **and** the candidate DOM for that result set is ready, or the payload explicitly reported an empty result |
| open note | the detail response for this note id has arrived **and** the note state for that id is populated |
| first comment page | the comment-page response for this note id has arrived, or the page reports the first comment request finished with an empty list |
| more comments | a comment-page response matching this note id **and** a non-empty cursor this task requested has arrived |

Notes:

- Search must not stop at the response. The candidates come from the DOM, and the DOM may render
  after the response. Both signals are required, and neither alone may be reported as success.
- A result set that is genuinely empty is success with zero candidates, but only when the payload says
  so. An absent or malformed payload is a failure.
- Duplicate requests for the same path are common. Attribution uses an operation-scoped version plus
  the request's own selector: query and page for search, note id and cursor for comments, note id for
  the detail. Arrival order is never used.

## Handles and lifetime

Public results are cacheable for the engine's cache TTL. A cached result does **not** extend the life
of a tab.

A candidate reference carries:

```text
noteId             stable identity of the target
path               clean path, no query string
label              title, or surrounding text, or image alt — may be empty
role               which link of the card this is (cover / title / other)
tabGeneration      which pooled tab holds this document
contentGeneration  bumped on every same-document route change and every document replacement
position           ordinal within that document, for re-resolution only
```

Identity is a pair, and both halves are checked:

- **Page and context generation.** Which browser generation produced the tab.
- **Content generation.** SPA routing replaces the document without a new page. Tracking only the
  document would leave a reference alive across a route change that invalidated every card.

A follow-up read:

1. Takes an admission slot.
2. Re-acquires exclusive ownership of the referenced tab from the pool.
3. Verifies generation, content generation, and that `noteId` is still present and operable.
4. Clicks only after that verification; `position` is a hint for finding it again, never a click
   target.
5. Fails with a distinct stale-reference error if any check fails. It does not click a different
   card, and it does not fall back to the interface path.

Because a pooled tab lives at most one idle window while search results are cached for fifteen
minutes, a cached result can easily outlive its tab. That is expected: the reference is reported
stale, and the caller may retry from a fresh search or supply a share link.

### Opening by target instead of by candidate

A caller may pass a note URL. That opens the target in the caller's own tab. It is a defined
operation, not a fallback.

A bare note id is accepted only when a live candidate for that id exists in the current session.
Otherwise the read fails with an actionable error asking for a share link. A token is not evidence of
session ownership, so an id alone cannot be resolved safely.

## Candidates

A search yields two things that must stay separate:

1. **Public results** — URL, title, summary. Cacheable and shown like any other source.
2. **Private candidate references** — the fields above, held in an internal registry. They are never
   carried on a public `Source`, because the compact path rebuilds `Source` and would drop or leak
   them.

Constraints:

- A card may have several links to the same note, and some links have no text and no `aria-label`.
  Text is not a required field.
- The same note may appear in more than one card. Deduplicate by `noteId` for output; keep the first
  operable reference.
- After opening a note, the result cards remain in the document behind the detail layer. Their
  presence is not evidence that they are clickable.
- Whether a candidate is obscured is re-checked by the execution layer immediately before the click.
  Geometry observed during search is stale by definition and is not given to the model as a decision
  input.

## Payload shape

Network responses use wire names (`note_card`, `model_type`, `has_more`, `xsec_token`). The page's own
state uses camelCase and may wrap values in reactive objects. These are two different sources and are
normalised separately, then merged behind one internal shape.

Rules:

- A response that is present but the wrong shape is a failure, not an empty result.
- Identity is only satisfied by an explicit signed-in answer. A missing or malformed identity payload
  is a failure, not a pass. The check reads the identity field directly; a negated truthiness test on
  a nullable object is what produced a false pass before.
- No token, cursor or signed media URL leaves the process in a user-facing field.

## Failure semantics

Refusals are not one thing. They are split by scope:

| Situation | Scope | Result |
| --- | --- | --- |
| page path produced no expected response in budget | this read | timeout error, tab closed, slot released |
| candidate stale or no longer resolvable | this read | stale-reference error, no click attempted |
| response present, shape unexpected | this read | protocol error |
| identity missing or malformed | this read | authentication error, no business operation |
| note is private, deleted or unauthorised for this account | this read only | subject refusal; the tab and session stay usable |
| captcha, account challenge, expired sign-in (401/406) | whole site | site gate closes; queued reads for this site are rejected |
| HTTP 403 without a challenge signal | this read only | subject refusal, reported as such |

The 403 case deserves its own line because treating every 403 as a site-wide stop would let one
private note cancel every queued read for the site. A refusal caused by the subject does not
invalidate the tab or the context.

The site gate is opened by the queue itself, not by the engine:

- It closes before the failing lease releases its slot, so a queued read cannot start on a site the
  session has just been challenged on.
- Queued reads for that site are rejected with a distinct error. Other backends are untouched.
- The failing lease does not hold its slot while waiting for its own drain.
- The gate does not reopen automatically. It reopens when the session is replaced, which is what
  already happens on an authentication failure.

There is no automatic interface fallback. If the page path stops working, it must be visible, because
the interface path is exactly what this change is moving away from.

## Comments

The detail page loads its first comment page by itself.

- `withComments: false` means: do not emit comments, do not scroll for more. It cannot promise the
  site sends no comment request, because the page does that on its own.
- `withComments: true` reuses what the page already loaded, then scrolls the comment container only
  when the page reports more available.
- Continuation uses the cursor the page already holds. Cursors are opaque strings, copied unchanged.
- Comments are deduplicated by id. Replies are not collected in this work.

Detail and comments are **one transaction**, not two. Both hosts currently call `fetchXhsNote` and
then `fetchXhsComments` as separate core reads, so the first comment page has no place to be reused
and each read repeats an identity probe. The comment request moves inside the detail transaction,
gated by `withComments`.

## Media

Image URLs may be signed and time-limited, so they must not reach a user-facing field. Today they do:
the note report carries `imageUrls`, the DSH tool appends the URL beside each downloaded path, and
the MCP tool echoes the URL in every inline image entry, including failures.

The bytes are the useful part, and they stay:

- The note report stops carrying raw image URLs. Download or inline results keep their local path or
  their base64 payload.
- A picture that failed to download is reported by ordinal and a short digest, not by URL, so the
  reason is still actionable without echoing the link.
- Deduplication, ordering and limits keep their current behaviour.

Whether the URLs actually carry signatures in practice is **unverified**; the design removes the
exposure regardless, because the cost is small and the leak is silent.

## Testing

Deterministic tests, no network.

Lifecycle assertions from the existing suite stay: one connection, one context, the concurrency cap,
stale drain, no replay, read-only state, total close budget, idle only when idle.

Structural assertions change: the suite currently asserts that four concurrent reads create exactly
one page. That assertion describes the implementation being replaced, so it is updated to assert one
page per active lease and a shared context.

New coverage:

- two concurrent tasks get two distinct tabs; neither sees the other's responses
- a listener armed before the trigger catches a response that arrives after the title is ready
- search fails when candidates never render, even though the response arrived
- two responses matching the same path are attributed by note id or cursor, not by arrival order
- a handle survives a search lease and re-acquires the same tab
- a handle whose content generation moved is refused, not clicked on the new content
- a handle whose tab was evicted or idled out reports stale, and never clicks by ordinal
- two tabs of one context, one going stale, drains and recycles exactly once
- after a 429 the session admits one lease and recovers only as already specified
- every failure path releases the tab, the slot and the listeners
- cancellation during an operation leaves the other tab untouched
- an empty result is accepted only when the payload says empty
- a missing or malformed identity payload is rejected
- a private note does not close the site gate; a challenge does, and rejects queued reads
- detail and comments run as one transaction and reuse the first comment page
- `onlyBackend` and compact paths neither leak a private target nor lose a candidate
- media results carry paths or payloads and never a raw image URL

Passing the current suite is a regression baseline, not evidence that this architecture is covered.

## Decisions taken during implementation

These were open questions in the design and are now settled in the code.

- **Pooled tabs are kept, bounded to two.** A candidate reference is only usable while its tab
  lives, so closing every tab after a read would make the reference useless. The pool holds at most
  two tabs and evicts the least recently used one, so a long run cannot hoard pages. A pooled tab
  still dies with the session's idle window.
- **Content generation follows `framenavigated`.** The counter increments on the page's own
  navigation event, which fires for a `pushState` route change as well as for a new document. This
  signal has not been verified against the live site from inside this project's context; if a route
  change ever fails to surface, the generation would lag and a stale reference could survive. The
  path check in the handle is the second line of defence.
- **A bare note id requires the handle from the search that listed it.** A share link is accepted on
  its own. This is stricter than the previous behaviour, and it is what makes an id safe to act on.
- **Image URLs no longer leave the process.** The note report drops them; hosts report pictures by
  ordinal plus a short digest, or by local path. The bytes are still delivered.

## Verification still owed

- Whether these requests pass through a service worker in the target environment. If they do,
  response events may not surface and the completion conditions would need a different signal.
- Whether image URLs observed from the site carry signatures, and their lifetime.
- Whether the identity field shape holds across page types, since one context reported a signed-out
  flag while the identity payload reported signed in.
