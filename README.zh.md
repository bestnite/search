# Search

[English](README.md) | 简体中文

你能自己掌控的网页搜索。想用哪家就用哪家，启用前就能看到它的费用，失败时直接告诉你失败原因。这个仓库包含共用的搜索引擎，以及使用它的两种方式。

一共 24 个后端，从完全免登录到按量付费都有。各家的额度、单价和核实日期见 [BACKENDS.md](packages/dsh-search/docs/BACKENDS.md)。

## 我该装哪个

| 你想做的事 | 装这个 | 位置 |
| --- | --- | --- |
| 在 DeepSeek Harness 里搜索 | `@nite07/dsh-search` | [packages/dsh-search](packages/dsh-search/README.zh.md) |
| 给任意 MCP 客户端加一个搜索工具 | `@nite07/websearch-mcp` | [packages/websearch-mcp](packages/websearch-mcp/README.zh.md) |
| 自己写客户端 | `@nite07/search-core` | [packages/core](packages/core/README.zh.md) |

DSH 插件和 MCP 服务都只是同一个 core 的外壳，所以在一处启用的后端，在另一处行为一致。

## 从这里开始

**DeepSeek Harness**

```sh
dsh plugin add @nite07/dsh-search
```

然后打开 **设置 → 网页搜索**，挑后端，保存。完整步骤见 [dsh-search 说明](packages/dsh-search/README.zh.md)。

**MCP 客户端**

```sh
npm install -g @nite07/websearch-mcp
websearch-mcp --print-config > ~/.config/websearch-mcp/config.json
```

编辑这个文件启用后端，再把客户端指向 `websearch-mcp` 命令。完整步骤见 [websearch-mcp 说明](packages/websearch-mcp/README.zh.md)。

**自己写代码**

```sh
npm install @nite07/search-core
```

先跑 [core 说明](packages/core/README.zh.md) 里的最小示例。

## 文档

| 页面 | 讲什么 |
| --- | --- |
| [packages/core](packages/core/README.zh.md) | 库的 API、引擎、后端目录 |
| [packages/core/image](packages/core/image/README.zh.md) | 起浏览器容器、登录站点 |
| [packages/dsh-search](packages/dsh-search/README.zh.md) | DSH 插件、设置界面、agent 工具 |
| [packages/websearch-mcp](packages/websearch-mcp/README.zh.md) | MCP 服务、配置文件、客户端接入 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 仓库结构、构建、测试、发布 |
| [docs/BROWSER-SESSIONS.md](docs/BROWSER-SESSIONS.md) | 浏览器会话的内部机制 |
| [docs/MIGRATION.md](docs/MIGRATION.md) | 为什么合成一个仓库，以及迁移过程 |

## 许可

MIT，各个包保留原有许可证。

## 友链

- [LINUX DO](https://linux.do) — 这个项目的后端调研最早从这里开始。
