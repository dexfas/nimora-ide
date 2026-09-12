# ShunCode 开源重建说明

## 为什么需要重建

当前机器上没有找到 ShunCode 原始完整开发仓库，但安装目录 `C:\Program Files\ShunCode\resources\app` 包含：

1. Code - OSS 编译后的产品文件；
2. `extensions/shuncode/src` 下的第一方 TypeScript 源码；
3. `dist/extension.js.map`、`runtime/agent-host.js.map`、`runtime/mcp-server.js.map` 中完整的 `sourcesContent`；
4. `product.json` / `package.json` 的产品差异信息。

因此本仓库采用“官方 VS Code 1.132.0 源码 + ShunCode 增量恢复”的方式，而不是反编译整个 `Program Files`。

## 已恢复的根级源码

从 source map 恢复到 `src/`：

- `agent-host.ts`
- `apply-patch.ts`
- `canonical-diff.ts`
- `deepseek-compat.ts`
- `file-tool-registry.ts`
- `find-files.ts`
- `ide-tool-definitions.ts`
- `mcp-server.ts`
- `openai-agent.ts`
- `read-files.ts`
- `search-files.ts`

这些文件不是根据行为猜写，而是直接来自安装包 source map 的 `sourcesContent`。

## 已恢复的第一方扩展

`extensions/shuncode/` 来自安装包随附源码，包含原生 Chat/Agent、模型提供器、Codex、Bridge、工具 broker、LSP、终端、多模型分支与相关配置。

安装包中的 `tsconfig.json` 原本仍引用开发目录 `../../vscode-main/src/vscode-dts/...`；在本仓库中已改为 `../../src/vscode-dts/...`，使路径适配当前完整 Code - OSS 根目录。

## 未声称完全恢复的内容

- 原始私有 Git 历史；
- 最初构建 ShunCode 安装包时使用的全部发布流水线；
- 任何未包含在源码、source map 或产品元数据中的私有构建脚本；
- 与具体机器绑定的配置、密钥、登录态和浏览器 profile。

因此“开源副本”代表当前可验证源码状态，不声称能逐字节复现现有安装包。

## 上游差异原则

产品配置只迁移可复现的 ShunCode 差异，例如：

- 产品名、协议名、数据目录名；
- Open VSX gallery；
- ShunCode API proposals；
- ShunCode 第一方扩展；
- Windows ShunCode 品牌资源。

安装时注入的 `checksums`、build id、构建日期等不会硬编码回源码仓库。

