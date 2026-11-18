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
3. 按下一节把服务注册到你的 MCP 客户端
4. 让客户端搜点东西

想先看看有什么可用又不花钱，调 `list_backends`：它列出每个后端的模式、费用档、启用状态以及有没有凭证，但不会启用任何东西。

## 配置页面

配置有页面了：每个后端的接入模式、成本档位、选项与凭证都在同一张表里，每张卡片带一个实测按钮。
它跑在自己进程里——常驻一个实例守着页面，MCP 客户端照旧拉起 stdio 服务，互不影响。

```sh
websearch-mcp --ui                                    # 只听 127.0.0.1:7799
websearch-mcp --ui --host 0.0.0.0 --port 7799         # 局域网可达，令牌照旧
websearch-mcp --print-url --host 0.0.0.0 --port 7799  # 打印要打开的链接
websearch-mcp --rotate-token                          # 作废之前发出的所有链接
```

- 绑定地址和端口是启动参数：`--host` / `--port`，或环境变量 `WEBSEARCH_MCP_UI_HOST` /
  `WEBSEARCH_MCP_UI_PORT`。默认只绑 loopback。
- 第一个请求必须带 `?token=`，它会被换成 `HttpOnly` + `SameSite=Strict` 的 cookie，链接不会留在
  浏览器历史里。令牌存在配置旁边的 `ui-token`，权限 0600。链接等同密码：页面能写凭证。
- 保存时用服务端同一套 schema 校验。被拒的保存不动文件，按字段路径列出所有问题；通过的保存先写
  `config.json.bak-<本地时间>`（保留 5 份），再原子替换文件并设为 0600。
- 正在跑的 stdio 服务监听到文件变化就重读，所以保存后下一次 `web_search` 就用新配置，不用重启
  客户端。文件如果解析不了，保留上一份可用配置，并在 stderr 说明原因。

常驻页面用用户级服务即可，不必上容器：

```ini
[Unit]
Description=websearch-mcp settings WebUI
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/websearch-mcp/dist/main.js --ui --host 0.0.0.0 --port 7799
Restart=on-failure
UMask=0077

[Install]
WantedBy=default.target
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

环境变量没有时，可以用配置文件里的 `credentials.<后端-id>` 直接写值。值是字面字符串，`${...}` 不会被展开。加载时保存的 `credentialRef` 字段会被丢弃，配置文件没办法把查询指到别的密钥上。

## 需要浏览器的搜索

小红书只认自己的页面运行时，所以它走你自己托管的浏览器容器。按 [packages/core/image](../core/image/README.zh.md) 起容器、在 VNC 里登录，然后把它配进来：

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

端点令牌写在 `DSH_SEARCH_BROWSER_TOKEN`，或者文件里的 `credentials.browser`。`maxConcurrentReads`（1–8）限制同一个站点上同时跑几个读取，默认值是保守的本地取值，不代表站点额度。`statePath` 必须是容器写的那个文件，否则每次读回来都是未登录。只要端点配好就能搜索；读笔记走的是同一个浏览器，所以后端必须启用为 browser 模式，`xiaohongshu_note` 吃 App 里复制的分享链接（里面带着读取要用的 token），或者之前搜索返回的笔记 id。

## 工具

| 工具 | 做什么 |
| --- | --- |
| `web_search` | 在已启用的后端里搜索。参数 `query`，可选 `mode`、`backends`、`allBackends`、`exclude`、`backend`、`compact`、`maxResults`。没法满足的选项会在报告里点名，不会被悄悄忽略。 |
| `read_thread` | 读一个讨论帖，图片以 MCP 图片内容返回（按张数、单文件大小和单次预算限制，所有链接都会列出）：`source: "reddit"` 读帖子及评论树（可设 `sort`、`limit`、`depth`），`source: "x"` 读推文及回复（需要 X 后端处于会话模式）。评论内容是用户生成的，不可信。 |
| `xiaohongshu_note` | 读一篇笔记：正文、作者、赞藏评转、标签、配图（以图片内容返回），需要的话再读一层评论（只有一层，`commentLimit` 1–50）。需要小红书后端处于 browser 模式且浏览器端点已配置；后端没开、端点没配、缺笔记 token 都会直说，不会回一篇空笔记。 |
| `list_backends` | 列出每个后端的模式、费用档、启用状态和凭证是否就位。不会启用任何东西。 |

`compact: true` 只回 URL、标题和日期，通常就是一个还能用的上下文和一个被灌满的上下文的区别。

## 可以依赖的行为

- **不切换。** 后端只按你选定的模式、你给的凭证、配置里的端点工作。重试不会换服务商、不会换模式。
- **失败看得见。** 部分失败返回成功的那部分并点名失败的；全部失败就说搜索失败。失败的调用不会进缓存。
- **单次策略不动配置。** `mode`、`backends`、`compact` 只作用这一次，所以窄查询和广撒网可以并存，不用来回改文件。
- **Reddit 默认匿名。** 不需要账号，用的就是安卓客户端拿的那种匿名 token——Reddit 的公开 REST 搜索对匿名调用一律 403。
- **X 的帖子按站点自己的方式读。** 适配层读页面里内嵌的那个接口再直接调用，前端发版不会失效，也不需要自己签 transaction id。

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
