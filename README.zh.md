# dsh-search

[English](README.md) | 中文

给 DeepSeek Harness 用的多后端网页搜索：21 家搜索服务，逐个开关，每个都明确选定接入模式、标明费用档。

## 安装

```sh
dsh plugin add @nite07/dsh-search
dsh --profile web   # 或者用你自己的方式重启 dsh web
```

也可以在 **设置 → 插件 → 添加插件** 里安装。

装完把它设为搜索来源：打开 **设置 → 网页搜索**，如果页面提示当前不是本插件，点「**设为网页搜索来源**」。

## 快速开始

1. 打开 **设置 → 网页搜索**
2. 在「搜索后端」页签里挑后端，逐家选择**匿名**或 **API Key** 模式，先看费用说明再启用
3. 点「保存设置」。所有后端默认关闭，不保存就一个请求都不会发出

想先验一下某家通不通，用「试搜与诊断」页签：它会明确发一次搜索，并把结果和失败原因原样显示出来。

## 后端与费用

每个后端按**当前选中的接入模式**归类到费用档：免费、免费额度（需密钥）、试用额度、付费用量、自托管。

- 无需账号即可用的免费档：Keenable、Exa、You.com、AnySearch、Parallel
- 本机自建 SearXNG 也支持，不需要密钥
- 带「**已实测**」标记的，表示本插件真实调用成功过

各家的额度、单价、来源链接和核实日期见 [docs/BACKENDS.md](docs/BACKENDS.md)。

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
