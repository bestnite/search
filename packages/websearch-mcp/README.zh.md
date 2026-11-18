# websearch-mcp

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/@nite07/websearch-mcp?label=npm&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/websearch-mcp)
[![downloads](https://img.shields.io/npm/dm/@nite07/websearch-mcp?label=downloads&style=flat-square&color=cb3837)](https://www.npmjs.com/package/@nite07/websearch-mcp)

一个多后端网页搜索的 MCP 服务，另外能读 Reddit 和 X 的讨论帖，以及小红书的笔记。任何 MCP 客户端都能用：Claude Code、Codex、DeepSeek Harness，或者你自己写的。

## 为什么还要一个搜索 MCP

多数搜索 MCP 会替你选好一家，然后什么都不说地失败。这个反过来：每个后端的接入模式由你指定，每种模式标了费用档，失败时直接点名是哪家失败、为什么失败，而不是回一个空结果。模型还能只对单次调用提要求——并行还是单家、问哪几家、每个源返回多少——这样查个小问题不至于和广撒网一个价钱。

## 安装

```sh
npm install -g @nite07/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

`--print-config` 生成一份完整且合法的配置，除了 Keenable 和 Reddit（这两家不需要账号）之外全部关闭。

## 第一次搜索

1. 打开 `~/.config/websearch-mcp/config.json`
2. 在 `search.backends` 里把想用的那几家改成 `"enabled": true`。匿名档的 Keenable、Exa、You.com、AnySearch、Parallel、Reddit 不需要额外配置
3. 按「客户端配置」把服务注册到你的 MCP 客户端
4. 让客户端搜点东西

想先看看有什么可用又不花钱，调 `list_backends`：它列出每个后端的模式、费用档、启用状态以及有没有凭证，但不会启用任何东西。

## 搜索结果

每条结果都会标注找到它的后端，同一页面可以保留多个来源。响应还会说明本次使用了哪些后端，
以及是否命中缓存。

## 配置页面

在配置页面选择后端、查看费用、填写凭证，也可以直接测试是否可用：

```sh
WEBSEARCH_MCP_UI_PORT=7799 WEBSEARCH_MCP_UI_TOKEN=replace-with-a-long-random-token websearch-mcp
```

打开 `http://127.0.0.1:7799/?token=replace-with-a-long-random-token`，页面会随 MCP 服务一起运行。
需要更改监听地址时设置 `WEBSEARCH_MCP_UI_HOST`。不设令牌时页面无需登录，向本机以外开放前请设置令牌。

页面分为搜索、可靠性、诊断、后端、浏览器和页面抓取几个部分。保存后下一次调用即使用新配置，
无需重启服务；无效配置不会保存，近期配置会自动备份。

只运行配置页面：

```sh
websearch-mcp --ui --port 7799 --token replace-with-a-long-random-token
```

## 客户端配置

```json
{
  "mcpServers": {
    "websearch": {
      "command": "websearch-mcp",
      "env": { "WEBSEARCH_MCP_CONFIG": "/home/you/.config/websearch-mcp/config.json" }
    }
  }
}
```

想显式指定文件时也可以用 `--config <path>`。两者都没有时，服务读取 `~/.config/websearch-mcp/config.json`。

## 凭证

凭证名字由 search-core 固定，不是配置项：后端 id 转大写、连字符换下划线，再加 `_KEY`。Brave 是 `DSH_SEARCH_BRAVE_KEY`，知乎站内是 `DSH_SEARCH_ZHIHU_SITE_KEY`。

放到客户端能看到的地方：

```json
{
  "mcpServers": {
    "websearch": {
      "command": "websearch-mcp",
      "env": {
        "WEBSEARCH_MCP_CONFIG": "/home/you/.config/websearch-mcp/config.json",
        "DSH_SEARCH_BRAVE_KEY": "…"
      }
    }
  }
}
```

环境变量没有时，可以用配置文件里的 `credentials.<后端-id>` 直接写值。值是字面字符串，`${...}` 不会被展开。

## 需要浏览器的搜索

小红书搜索和笔记读取需要浏览器容器。按 [packages/core/image](../core/image/README.zh.md) 起容器、在 VNC 里登录，然后把它配进来：

```json
{
  "search": {
    "browser": {
      "endpoint": "ws://127.0.0.1:3000/ws",
      "statePath": "/path/to/search-browser/data/state.json",
      "timeoutMs": 60000,
      "maxConcurrentReads": 2
    },
    "backends": {
      "xiaohongshu": { "enabled": true, "mode": "browser" }
    }
  }
}
```

端点令牌写在 `DSH_SEARCH_BROWSER_TOKEN` 或文件里的 `credentials.browser`。
`statePath` 填容器保存登录态的文件路径，`maxConcurrentReads`（1–8）控制同一站点的并发读取数。

读取笔记时，向 `xiaohongshu_note` 传入 App 中复制的完整分享链接，或之前搜索返回的笔记 id。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `web_search` | 搜索指定后端。必填 `query`，可选 `backends`、`allBackends`、`exclude`、`compact`、`maxResults`。只指定一个后端就只搜这一家，不指定则搜索所有已启用后端。 |
| `reddit_thread` | 读取 Reddit 帖子、评论和配图。 |
| `x_thread` | 读取 X 帖子、回复和配图，需要 X 后端处于会话模式。 |
| `xiaohongshu_note` | 读取笔记正文、作者、互动数据、标签和配图，可选读取评论。需要启用小红书后端的 browser 模式并配置浏览器。 |
| `list_backends` | 查看后端、接入模式、费用、启用状态和凭证是否就绪。 |
| `search_manage` | 查看或修改设置与凭证，测试后端或页面抓取。 |
| `web_extract` | 读取单个网页，返回 Markdown 或 HTML。默认关闭，在「页面抓取」中启用。 |

`compact: true` 不返回摘要，保留链接、标题、日期和来源后端。

原 `read_thread` 已由 `reddit_thread` 和 `x_thread` 替代，已有调用请改用对应平台的工具，不再传入 `source`。

## 让 Agent 管理设置

可以让 Agent 用 `search_manage` 查看设置、调整后端或页面抓取选项、设置或清除凭证，
也可以测试已保存的后端与抓取配置。工具不会返回凭证值，修改后无需重启 MCP 服务。

Agent 应先读取设置（`action: "settings"`），再提交修改后的完整配置和读取时的 `expectedRevision`
（`action: "save"`）；修改凭证也需要带上该版本。`test` 和 `fetch-test` 会发出真实请求，可能产生费用。
修改配置、凭证或运行测试前，都需要你的授权。

## 页面抓取

用 `web_extract` 读取已知 URL，返回 Markdown 或 HTML。在设置页启用，或将配置文件中的
`search.tools.webExtract` 设为 `true`。

```json
{ "url": "https://example.com/article", "format": "markdown" }
```

需要查看页面结构时使用 `"html"`。支持读取需要 JavaScript 的页面，也可以在「页面抓取」中选择服务商。
使用前请查看支持的格式和费用，需要 API Key 的模式应先填写凭证。默认只允许公网地址。

## 可以依赖的行为

- **不切换。** 后端只按你选定的模式、你给的凭证、配置里的端点工作。重试不会换服务商、不会换模式。
- **失败看得见。** 部分失败返回成功的那部分并点名失败的；全部失败就说搜索失败。失败的调用不会进缓存。
- **单次策略不动配置。** `backends`、`exclude`、`compact` 只作用这一次，所以窄查询和广撒网可以并存，不用来回改文件。
- **Reddit 默认匿名。** 不需要账号。
- **X 讨论支持读取回复。** 需要使用会话模式，并提供有效的账号 Cookie。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 客户端里看不到工具 | 服务没起来。手动跑一次 `websearch-mcp --config <path>` 看报错。 |
| 每次搜索都失败 | 没有启用任何后端。先调 `list_backends`，启用一家，再重启客户端。 |
| 某个要 Key 的后端报缺凭证 | 环境变量名是按后端 id 生成的，用 `list_backends` 核对准确名字。 |
| 小红书报没有端点 | `search.browser.endpoint` 是空的，后端自己也没配端点。 |
| 小红书报未登录 | 容器的登录态过期了。去 VNC 里重新登录，下次读取会重新加载会话文件。 |

## 开发

见 [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)。

## 许可

MIT。
