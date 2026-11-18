# @nite07/search-core

[English](README.md) | 中文

一个不绑定宿主的 TypeScript 多后端网页搜索引擎。后端目录、各家的适配层、HTTP 传输和一个 `SearchEngine` 都在这里，不依赖任何宿主框架——[DeepSeek Harness 插件](../dsh-search/README.zh.md) 和 [MCP 服务](../websearch-mcp/README.zh.md) 都只是它的外壳。

## 安装

```sh
npm install @nite07/search-core
```

## 最小示例

```ts
import { SearchEngine, defaultConfig } from '@nite07/search-core';

const config = defaultConfig();
config.backends.exa!.enabled = true;       // 匿名模式，不需要凭证
config.backends.keenable!.enabled = true;

const engine = new SearchEngine(
  config,
  async reference => process.env[reference],  // 凭证从哪来由宿主决定
);

const result = await engine.search({ query: 'cordis plugin loader', maxResults: 8 });
console.log(result.sources);   // 可引用的来源：url、title、snippet、publishedAt
console.log(result.content);   // 可读的报告，失败原因也在里面
```

所有后端初始都是关闭的，上面那两行就是打开它们的地方。

## 选后端

`catalog` 列出全部 24 个条目，包含每个后端的接入模式、费用档、额度说明和可选项。大部分有免费或免 Key 的用法，少数需要 Key、OAuth、会话 cookie，或者一个你自己托管的浏览器。

```ts
import { catalog } from '@nite07/search-core';

for (const backend of catalog) {
  console.log(backend.id, backend.modes.map(mode => `${mode.mode}:${mode.tier}`).join(' '));
}
```

按你想要的模式启用，需要的话再设选项：

```ts
config.backends.searxng!.enabled = true;      // 自托管，不需要凭证
config.backends.searxng!.mode = 'anonymous';
config.backends.searxng!.endpoint = 'http://127.0.0.1:8385/search';
```

各家的额度与价格表见 [BACKENDS.md](../dsh-search/docs/BACKENDS.md)。

## 凭证

凭证名字固定在代码里，不是配置项；两个辅助函数都导出了，宿主想怎么存密钥都行：

- `backendCredentialRef(id)` — `DSH_SEARCH_<后端ID>_KEY`，连字符换成下划线、id 转大写。
- `browserCredentialRef()` — `DSH_SEARCH_BROWSER_TOKEN`，所有走浏览器的读取共用这一个令牌。

匿名模式从不解析凭证，`parseConfig` 会丢弃保存的 `credentialRef` 字段，不让配置文件把查询指到别处。

## 结果与失败

`search()` 总会给出报告，后端失败不会抛异常：

```ts
const result = await engine.search({ query: 'x', maxResults: 8 });
result.sources;   // 成功的那部分，已去重并融合排序
result.content;   // 可读报告，点名每个失败的后端和原因
result.outcomes;  // 每个后端的细节：ok、错误类型、耗时、尝试次数
```

部分失败保留成功的结果；全部失败时直说搜索失败，而不是回一个空列表。失败的调用不进缓存。

`search(input, signal?, onlyBackend?, overrides?)` 支持单次调用的策略覆盖：`mode`、`backends`、`exclude`、`backend`、`compact`、`maxResults`，不改动已保存的配置。

## 接入模式

后端只按你选定的模式工作：`anonymous`、`key`、`oauth`、`session` 或 `browser`。模式、密钥、端点之间都不会自动切换，重试也留在同一家、同一模式。只重试配置里列出的 HTTP 状态码，`Retry-After` 会被遵守，重试不会换服务商。

## 需要浏览器的后端

只认自己页面运行时的站点（目前是小红书）走你自己托管的浏览器。按 [`image/`](./image/README.zh.md) 起容器、在 VNC 里登录一次，然后：

```ts
config.browser.endpoint = 'ws://127.0.0.1:3000/ws';
config.browser.statePath = '/path/to/search-browser/data/state.json';
config.browser.maxConcurrentReads = 3;   // 可选，同站点并发上限；默认 2，范围 1–8
config.backends.xiaohongshu!.enabled = true;
config.backends.xiaohongshu!.mode = 'browser';
```

端点令牌从 `DSH_SEARCH_BROWSER_TOKEN` 解析。端点本身允许匿名连接时，缺令牌也不影响连上去。这个库只负责连上去和读取，登录和 profile 始终归那个浏览器的主人。

`maxConcurrentReads` 限制同一个站点上同时跑几个读取。它是本地的安全上限，不是站点额度；超出范围会当作配置错误，而不是悄悄截断。

不想经过引擎、只想发一次请求的宿主，可以直接用导出的读取函数：`searchXhs`、`fetchXhsNote`、`fetchXhsComments`、`searchX`、`fetchXThread`、`fetchRedditThread`。

会话、代际和回收的内部机制见 [docs/BROWSER-SESSIONS.md](../../docs/BROWSER-SESSIONS.md)。

## 字段映射

每个适配器读哪个响应字段、对着官方文档核实过的结果，以及哪些缺口不算 bug，都记在
[docs/FIELD-MAPPING.md](docs/FIELD-MAPPING.md)。

## 许可

MIT。
