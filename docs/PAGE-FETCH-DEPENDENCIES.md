# Page Fetch: Dependency Evidence

Status: implementation record for [PAGE-FETCH-DESIGN.md](PAGE-FETCH-DESIGN.md). Checked 2026-11-18
against the npm registry, then installed in this worktree with `--ignore-scripts`.

Preference order from the repository rules: platform built-in, then a maintained package, then an
in-house implementation. Every choice below is a package that already exists, is permissively
licensed, and does one job; nothing is vendored, forked or patched.

## Chosen

| Package | Version | License | Last registry change | Unpacked size | Role |
|---|---|---|---|---|---|
| `turndown` | 7.2.5 | MIT | 2026-11-04 | 193 KB | HTML to Markdown conversion |
| `turndown-plugin-gfm` | 1.0.2 | MIT | 2022-05-22 | 24 KB | GFM tables, strikethrough, task lists |
| `@mixmark-io/domino` | 2.2.0 | BSD-2-Clause | 2024-04-08 | 7.7 MB (676 KB `lib/`, 6.9 MB of test fixtures) | DOM implementation used to parse the page once |
| `re2js` | 2.10.0 | MIT | 2026-11-10 | 914 KB | Linear-time regular expressions for fallback rules |
| `undici` | 8.12.4 | MIT | 2026-11-05 | 2.2 MB | Node's own fetch implementation, used for its dispatcher hook |

`@types/turndown` 5.0.6 (MIT) is a dev dependency: the converter ships no type declarations. The GFM
plugin also ships none, so its two export names are declared in
`packages/core/src/fetch/vendor.d.ts`; that file is a type declaration only and adds no runtime code.

### Why these

- **HTML to Markdown.** `turndown` is the established choice and is actively maintained (release
  within the last month of this change). The design requires GFM tables, code blocks and heading/link
  preservation without a handwritten converter, and forbids a vendored fork. `turndown-plugin-gfm`
  supplies the table/strikethrough/task-list rules; its last release is old but it is a small rule
  set layered on a stable API and is the canonical plugin for this converter.
- **DOM.** `turndown` already depends on `@mixmark-io/domino`, so parsing with domino adds no new
  transitive package and avoids a second DOM implementation. Domino is used directly for three
  things this change genuinely needs: the document title, a content-only text projection (script,
  style, template and identifiable hidden nodes removed) and rewriting relative links against the
  final URL before conversion. Serialising a cleaned DOM and handing that string to turndown keeps
  one parse instead of two.
  The 7.7 MB figure is dominated by upstream test fixtures; `lib/` is 676 KB and that is what is
  imported at runtime.
- **Bounded regular expressions.** The design refuses `Promise.race` around a synchronous `RegExp`
  as protection and requires a linear-time engine or terminable isolated execution. `re2js` is a
  pure-JavaScript port of RE2: matching is linear in the input, there is no backtracking, and it needs
  no native build, so it works in the settings UI bundle as well as in Node. Patterns that RE2 cannot
  compile (lookaround, backreferences) are rejected when the configuration is validated rather than
  failing at fetch time.
- **HTTP transport and DNS rebinding.** Node's built-in `fetch` accepts no dispatcher, so a request
  made through it re-resolves the host name after the policy check — a name that passed as public can
  connect to a private address. The HTTP route therefore runs on `undici`, the implementation Node's
  global `fetch` is built on: one `Agent` whose socket `lookup` resolves the name, applies the
  address policy to every answer, and returns the very address the socket then connects to. The
  validated address and the connected address are the same resolution, so the gap is closed rather
  than documented away. Redirects are still followed manually, one bounded hop at a time, and each
  hop's lookup repeats the same check. A host may inject another fetch-compatible transport; then its
  own connection policy applies, which the route states in the type and the docs.
- **No new browser driver.** The browser route reuses `patchright-core`, already the project's
  browser dependency for the shared browser endpoint.

### Trade-offs accepted

- Domino is a comparatively large source tree, and `turndown` is untyped upstream. Both are paid for
  by removing hand-written HTML parsing and conversion, which the design explicitly discourages.
- `turndown-plugin-gfm` is dormant upstream. If it ever stops working with a future `turndown`
  release, the tables/strikethrough rules can be expressed as a few turndown rules; that is a small,
  contained fallback rather than a fork.
- `re2js` has a smaller feature set than JavaScript `RegExp` on purpose. Rule authors lose
  lookaround and backreferences, and the save-time error says so.
- `undici` duplicates an API the platform already exposes. It is accepted because the built-in
  entry point cannot pin the socket lookup, and reimplementing an HTTP client to get that hook would
  be a larger and less trustworthy change. It is also the exact code path Node's own `fetch` uses.

## Deliberately not added

- No article-extraction library (Readability and similar): the design keeps visible navigation and
  footers instead of article-only extraction.
- No cookie jar or retry library: the route chain is the only fallback mechanism in v1.
- No third-party HTML fetcher or browser-automation package: the browser route uses the same
  `patchright-core` connection the project already supports.
- No HTML sanitiser for settings previews: the UIs render returned content as escaped text in a
  `<pre>`-style block, never as executable remote HTML.
