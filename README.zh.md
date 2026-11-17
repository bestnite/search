# dsh-search

[English](README.md) | 中文

给 DeepSeek Harness 用的多后端网页搜索：23 家搜索服务，逐个开关，每个都明确选定接入模式、标明费用档。

## 安装

```sh
dsh plugin add @nite07/dsh-search
dsh --profile web   # 或者用你自己的方式重启 dsh web
```

也可以在 **设置 → 插件 → 添加插件** 里安装。

装完把它设为搜索来源：打开 **设置 → 网页搜索**，如果页面提示当前不是本插件，点「**设为网页搜索来源**」。

## 快速开始

1. 打开 **设置 → 网页搜索**
2. 在「搜索后端」页签里挑后端，逐家选择接入模式（匿名、Key、OAuth、会话等），先看费用说明再启用
3. 点「保存设置」。所有后端默认关闭，不保存就一个请求都不会发出

想先验一下某家通不通，用「试搜与诊断」页签：它会明确发一次搜索，并把结果和失败原因原样显示出来。

## 后端与费用

列表按**每家最便宜的用法**分组，所以有完全免费路径的永远排在最前面。每行用 chip 标出**所有**模式各自的费用档，当前选中的那个高亮。

| 分组 | 有哪些 | 说明 |
| --- | --- | --- |
| **有完全免费的用法** | Keenable、AnySearch、Exa、Parallel、You.com、DuckDuckGo、Reddit | 不用注册、不用 Key，开箱可用 |
| **自带账号** | X | 用你自己 X 网页端的 cookie，不花钱，但 X 改动请求签名时会失效 |
| **自托管** | SearXNG、open-websearch | 自己跑服务，额度由你自己定 |
| **免费额度** | Linkup、Tavily、Brave、知乎（网页/站内）、百度、豆包 | 注册拿 Key，额度内免费 |
| **试用额度** | Serpex | 一次性试用额度，用完转付费 |
| **付费** | Mojeek、Anthropic、OpenAI、DeepSeek、腾讯 WSA | 按量收费，开之前先看单价 |

- 默认**全部关闭**，一个都不会自动启用
- 各家的具体额度、单价、来源链接和核实日期见 [docs/BACKENDS.md](docs/BACKENDS.md)

## 工具

- `web_search` — 上面说的多后端搜索。
- `web_search_plus` — 按本次调用指定搜索策略：（可在设置里关闭：关闭后不注册该工具）`mode`（单后端/并行）、`backends`（从已启用里挑子集）、`allBackends` + `exclude`（全用但排掉几家，比列 id 省字符）、`compact`（只回标题和链接，丢掉摘要，省结果 token）、`maxResults`。只影响这一次调用，不改配置；没启用的后端会被明确告知而不是被悄悄忽略，实际用了哪些也会回显。
- `reddit_thread` — 读某个 Reddit 帖子的完整评论树，让模型能引用真实讨论而不是猜；按深度、评论条数和字符预算截断。
- `search_manage` — 从 agent 侧查看或修改本插件自己的设置。

## 开发

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
```

设计与实现说明：[docs/PLAN.md](docs/PLAN.md)；验证记录：[docs/VERIFICATION.md](docs/VERIFICATION.md)。

## 许可

MIT。

## 友链

- [LINUX DO](https://linux.do) — 这个插件的后端调研起步于这个社区。
