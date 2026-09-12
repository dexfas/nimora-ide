# Nimora IDE 开源重建说明

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

## 生产源码完整性审计

安装版 `resources/app/out/**/*.js.map` 中包含可验证的 `sourcesContent`。重建过程中对全部 27 个 JavaScript source map 做了反向哈希审计：

- 可恢复的生产 `src/` 文件：4,995 个；
- 当前仓库与安装版 source map 一致：4,995 / 4,995；
- 缺失：0；
- 内容不一致：0；
- 同一路径 source map 冲突：0。

其中 `src/vs/platform/agentHost` 相对 Microsoft VS Code `1.132.0` 官方基线有 86 个内容差异文件和 2 个新增文件；这 88 个文件全部与安装版 ShunCode source map 精确一致。因此这些差异被视为已验证的 ShunCode 生产增量，而不是错误混入的上游版本。

这项审计证明的是“当前安装版实际发布源码”的恢复完整性，不等同于逐字节复现最终安装包，也不恢复原始私有 Git 历史。

## 构建时类型层差异

严格执行 Code - OSS 核心 `src` 的 tsgo no-emit 检查时，当前重建树仍会报告一批错误，主要来自没有进入安装版生产 bundle 的测试、类型声明和外围入口与发布源码快照不同步。生产 source map 覆盖的 4,995 个文件已经通过上述一致性审计，因此不能通过回退生产代码到官方 `1.132.0` 来“消除”这些错误。

默认上游编译行为仍保留严格核心 typecheck。`scripts/shuncode-dev.*` 会显式设置 `SHUNCODE_SKIP_CORE_TYPECHECK=1`，仅在重建开发启动流程中跳过核心 tsgo no-emit 阶段；实际 esbuild transpilation、内置扩展编译、ShunCode 第一方扩展 typecheck 和 Runtime 构建仍会执行。这个兼容模式用于验证恢复出的发布代码能否从源码运行，后续仍应逐步同步未发布的测试/类型层。

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

