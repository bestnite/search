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
mkdir -p ~/.config/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

这会生成初始设置，默认启用无需账号的 Keenable 和 Reddit。无需编辑生成的文件，后续在 Web UI 中操作，或让 Agent 帮你修改即可。

## 接入 MCP 客户端

在客户端的 MCP 设置中添加一个 **stdio** 服务：

| 字段 | 填写内容 |
| --- | --- |
| 名称 | `websearch` |
| 命令 | `websearch-mcp` |
| 参数 | 留空 |

客户端需要能找到该命令；找不到时，填安装后的可执行文件完整路径。如果客户端只接受配置文件，
按该客户端的说明添加 stdio 服务即可。

## 第一次搜索

让 Agent 使用默认后端搜索，也可以先让它列出可用服务商。例如：

> 用 Keenable 和 Reddit 搜一下最近的自托管新闻。

想更换后端、查看费用或调整搜索偏好，可以使用下面的 Web UI，或直接让 Agent 操作，无需手写配置。

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

## 凭证

在 Web UI 的服务商卡片中填写 API Key 或账号凭证并保存，也可以授权 Agent 通过 `search_manage`
设置或清除凭证。该工具不会返回凭证值。不要把密钥粘贴到共享对话中。

## 需要浏览器的搜索

小红书搜索和笔记读取需要浏览器容器：

1. 按[浏览器容器说明](../core/image/README.zh.md)启动容器，在 VNC 中登录小红书。
2. 在 Web UI 的「浏览器」部分填写容器提供的端点和端点令牌；使用登录态文件时，也在这里填写路径。
3. 在「后端」中启用小红书的 browser 模式并保存。

随后就可以让 Agent 搜索小红书，或读取从 App 复制的完整分享链接。

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

例如：

> 帮我看看有哪些免费后端，启用 Keenable 并保存。

测试会发出真实请求，可能产生费用。修改配置、凭证或运行测试前，都需要你的授权。

## 页面抓取

在 Web UI 的「页面抓取」中启用 **web_extract**，或让 Agent 帮你启用。
随后让它读取指定网页，返回 Markdown；需要查看页面结构时，可以要求返回 HTML。

支持读取需要 JavaScript 的页面，也可以在同一页面选择抓取服务商。使用前请查看支持的格式和费用，
需要 API Key 的模式先填写凭证。默认只允许公网地址。

## 可以依赖的行为

- **不切换。** 后端只按你选定的模式、你给的凭证、配置里的端点工作。重试不会换服务商、不会换模式。
- **失败看得见。** 部分失败返回成功的那部分并点名失败的；全部失败就说搜索失败。失败的调用不会进缓存。
- **单次策略不动配置。** `backends`、`exclude`、`compact` 只作用这一次，所以窄查询和广撒网可以并存，不用来回改文件。
- **Reddit 默认匿名。** 不需要账号。
- **X 讨论支持读取回复。** 需要使用会话模式，并提供有效的账号 Cookie。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 客户端里看不到工具 | 服务没起来。在终端运行 `websearch-mcp` 查看启动报错。 |
| 每次搜索都失败 | 没有启用任何后端。在 Web UI 中启用一家，或让 Agent 帮你启用，再重试。 |
| 某个要 Key 的后端报缺凭证 | 在服务商卡片中填写凭证，或授权 Agent 设置。 |
| 小红书报没有端点 | 在 Web UI 的「浏览器」部分填写端点。 |
| 小红书报未登录 | 容器的登录态过期了。去 VNC 里重新登录，下次读取会重新加载会话文件。 |

## 开发

见 [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md)。

## 许可

MIT。
