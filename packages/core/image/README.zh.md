# 搜索浏览器镜像

[English](README.md) | 中文

`@nite07/search-core` 里所有 `browser` 模式后端共用的浏览器容器。像小红书这类只认自己页面运行时的站点，就是通过这里的一个真实 Chrome 来读的，而不是调 HTTP 接口。

你自己跑它，在 VNC 里登录一次，搜索代码连上来。镜像本身不知道你在读哪个站，所以以后再接一个需要浏览器的后端也不用改镜像。

## 快速开始

```sh
cp env.example .env && chmod 600 .env   # 然后编辑它
podman compose up -d --build
podman logs search-browser              # 打印端点和令牌
```

记下打印出来的两个值——端点（`ws://<host>:<port>/ws`）和令牌。配置宿主时两个都要用。

不用 compose 的话，等价做法是一次 `podman build` 加一次 `podman run`，端口、卷和 `--shm-size=1gb` 保持一致。

## 登录

容器一直开着一扇浏览器窗口，不需要你手动去起：

1. 打开 `http://<host>:6080/vnc.html`，用 `BROWSER_VNC_PASSWORD` 连上
2. 在那扇窗口里打开需要登录的站点并登录。它就是普通浏览器，你在里面登过的站都进同一个 cookie 罐
3. 容器每分钟以及退出时把 `/profile/state.json` 写一遍。读取从这个文件起步，所以回来是已登录的

搜索代码没法替你登录，凭证也不会离开这个容器。

## 接上宿主

把 DSH 插件或 MCP 服务指向这个端点，并把令牌给它。DSH 插件的路径是 **设置 → 网页搜索 → 搜索后端 → 共享浏览器**。

| 字段 | 填什么 |
| --- | --- |
| 端点 | 启动时打印的 `ws://…/ws` |
| 端点令牌 | 启动时打印的令牌 |
| 会话文件 | `/path/to/data/state.json`，也就是 `/profile` 卷在宿主上的路径 |
| 读取超时 | 没超时就保持默认 |
| 同站点并发读取数 | 1–8，默认 2；本地并发上限，不是站点额度 |

MCP 服务里对应的是 `search.browser.endpoint`、`search.browser.statePath`、`search.browser.timeoutMs`、`search.browser.maxConcurrentReads`，令牌用 `DSH_SEARCH_BROWSER_TOKEN` 或 `credentials.browser`。详见 [MCP 说明](../../websearch-mcp/README.zh.md)。

会话文件必须是这个容器写的那个文件。宿主读不到这个路径，每次读回来就都是未登录。

## 配置

变量取自本目录的 `.env`（compose 用它做插值），也可以从 shell 传入。`env.example` 列出每个变量的默认值和原因。

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `BROWSER_BIND_ADDR` | `127.0.0.1` | 端口绑定的地址；别的机器要访问就改它 |
| `BROWSER_ENDPOINT_PORT` | `3000` | Playwright 端点的宿主端口 |
| `BROWSER_VNC_PORT` | `6080` | noVNC 的宿主端口 |
| `BROWSER_VNC_PASSWORD` | 空 | VNC 密码，最多 8 个字符；端口不在 loopback 上时必填 |
| `BROWSER_WS_TOKEN` | 空 | 端点令牌；留空时首次启动自动生成 |
| `BROWSER_START_URL` | `about:blank` | 登录窗口打开时先访问哪个地址 |

命名卷会让登录态跟着容器走。如果搜索代码和容器在同一台机器、需要直接读会话文件，改成 bind mount：把卷那一行换成 `- /path/to/data:/profile:Z`。

## 里面有什么

一个带虚拟显示器的 Chrome、一扇给人登录的窗口，以及一个需要令牌才能连的 Playwright 端点。

| 组成 | 为什么 |
| --- | --- |
| Patchright + Google Chrome | Patchright 是 Playwright 的分支，关掉了检测系统会查的那些 CDP 痕迹。它驱动的是真实 Chrome，也就是它作者推荐的构建 |
| 固定路径的 Playwright 服务 | 读取方连的是一个重启后不变的地址；Chrome 已经打进镜像，重启不用等下载 |
| `:3000` 上的令牌代理 | Playwright 除了路径难猜之外没有认证，而固定路径是能猜到的，所以代理要求 `Authorization: Bearer <token>` |
| `:6080` 上的 Xvfb + x11vnc + noVNC | 在无头服务器上给人留一扇能操作的浏览器窗口，用来登录 |
| 一个 keeper 客户端 | 浏览器服务只在有客户端连着时才显示窗口，所以留一个客户端常驻，窗口就一直在。它同时每分钟把登录态写盘 |
| `/profile` 卷 | 存放 `state.json`，也就是你登录过的所有站点的 cookie 和 localStorage |

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 连接时报 `428 Precondition Required` | 镜像里的 Patchright 驱动和 `search-core` 里的客户端 major.minor 不一致。重建或升级，让两边一致 |
| `podman restart` 之后端点像死了一样 | rootless 模式下直接 restart 可能留下容器跑着但端口没绑上的状态。改用重建：`podman compose up -d --force-recreate`，或者重启管理这个容器的 unit |
| 容器反复重启，日志指向 X | 重启后 `/tmp` 里留着旧的 X 锁。entrypoint 会先删掉它；确认你用的是较新的镜像 |
| 读回来都是未登录 | 宿主读的不是这个容器写的文件，检查会话路径 |
| noVNC 页面连不上 | 端口不在 loopback 上时必须设置 `BROWSER_VNC_PASSWORD` |

## 发布镜像

`.github/workflows/image.yml` 负责构建并推送到 Docker Hub 和 GHCR，标签跟的是 Patchright 驱动版本，而不是 npm 包版本。仓库需要 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 两个 secret；GHCR 用工作流自带的 `GITHUB_TOKEN`。推一个 `browser-v<version>` 标签触发发布，或者手动运行工作流，产出 `latest` 加 `sha-<short>`。

## 许可

MIT。

## 友链

- [LINUX DO](https://linux.do)
