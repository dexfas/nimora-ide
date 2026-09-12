# Source of Truth

## 1. 重建来源

Nimora 的代码基础来自：

1. Microsoft Code-OSS / VS Code `1.132.0`；
2. 安装版 ShunCode 随附的第一方扩展源码；
3. 安装版 JavaScript source map 的 `sourcesContent`；
4. 安装版 `product.json` / `package.json` 等产品元数据；
5. 开源重建后明确提交的兼容与验证修正。

上游 `1.132.0` tag 已确认指向 `df53daabb18cd157bdb08c7f01c34df936cf12f4`。当前 Git clone 并未长期保留该上游 commit object，因此不能假设任何环境都能离线执行 `git diff df53...`；后续应增加可重复的 upstream-baseline audit 脚本/缓存策略。

## 2. 生产源码恢复证据

安装版 `resources/app/out/**/*.js.map` 的 27 个 source map 曾完成完整反向哈希审计：

- recoverable production `src/`：4,995；
- 当前重建基线与 `sourcesContent`：4,995 / 4,995 一致；
- missing：0；
- content mismatch：0；
- same-path source-map conflict：0。

`src/vs/platform/agentHost` 相对官方 VS Code 1.132.0 的已验证差异为 86 changed + 2 added = 88 files，且这些文件与安装版 source map 完全一致。

注意：**88 只是 AgentHost 子树的已验证 upstream diff，不代表全部 ShunCode Core Patch 数量。** 当前 `src/vs/workbench/contrib/chat`、API、product/NLS 等位置还有明确 ShunCode 产品逻辑；这些关键文件的 Git 历史也都从最初重建提交 `a6d87b1` 开始。

## 3. Root recovered sources

以下 root `src/` 文件直接来自安装包 source map，而不是根据行为重写：

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

它们现在是维护源码；后续修改应直接修改这些 TypeScript source，而不是 runtime bundle。

## 4. 第一方 extension source

Canonical source：`extensions/shuncode/src/**`。

重建时：

- `package.json` 与安装版 manifest 字节级一致；
- 24 个 TypeScript source 中 23 个与安装版一致；
- `bridge-license-service.ts` 是明确的开源兼容修正；
- `tsconfig.json` 将安装开发环境的 `../../vscode-main/src/vscode-dts/...` 改为当前仓库 `../../src/vscode-dts/...`。

## 5. 生成物

`extensions/shuncode/esbuild.mts` 是第一方构建 Source of Truth：

| Source | Generated output |
| --- | --- |
| `extensions/shuncode/src/extension.ts` | `extensions/shuncode/dist/extension.js` |
| `src/agent-host.ts` | `extensions/shuncode/runtime/agent-host.js` |
| `src/mcp-server.ts` | `extensions/shuncode/runtime/mcp-server.js` |
| `@vscode/ripgrep` binary | `extensions/shuncode/runtime/bin/*` |

这些 `dist` / `runtime` 生成目录当前不在 Git 跟踪列表中。`out/`、`.build/` 同样是生成/开发产物，不是手工维护源码。

**规则：不要直接修生成物。** 如果只有生成物表现出问题，先定位对应 source/build script。

## 6. Code-OSS Core

`src/vs/**` 的默认 ownership 是上游 Code-OSS。任何带 Nimora/ShunCode 语义的修改都应：

1. 证明必须在 Core；或
2. 记录为兼容层并给出未来迁移方向。

不能因为文件已经存在于 Core 就默认永久保留；也不能因为 Extension-first 更“干净”就删掉真正依赖 Workbench 私有能力的功能。

## 7. 安装版 ShunCode

`C:\Program Files\ShunCode` 只用于：

- read-only 发行版参考；
- source map / metadata / log 对照；
- 必要时只读运行行为验证。

禁止：

- 修改；
- patch；
- 覆盖；
- 重装以配合源码测试；
- 用通用进程 kill 干扰正式实例。

源码 Nimora 测试必须使用 `.build` 下隔离 user-data/extensions/shared-data。

## 8. 构建层与发布层不是同一个真相

严格 Code-OSS root typecheck 仍会出现发布快照外的 test/declaration/外围入口问题。重建开发 launcher 只在源码恢复验证路径中设置 `SHUNCODE_SKIP_CORE_TYPECHECK=1`，但仍执行真实 transpile、第一方 extension typecheck/build 与 runtime build。

因此：

- production sourcemap 一致性不能被“root typecheck 当前有错”推翻；
- 同样，production sourcemap 一致性也不等于完整发布流水线已经恢复。

## 9. 未恢复 / 不应伪造的内容

- 原始私有 Git history；
- 原始完整发布 pipeline；
- source/source-map/metadata 中不存在的私有脚本；
- 机器绑定 token、账号、cookie、browser profile；
- historical cloud service secrets。

文档和测试不得为了“完整”而编造这些内容。

## 10. 修改决策表

| 想改什么 | 首选位置 |
| --- | --- |
| file tool schema/behavior | root `src/*tool*` canonical source |
| IDE/LSP/terminal implementation | `extensions/shuncode/src` capability provider |
| Native Chat adapter | `extensions/shuncode/src/native-chat.ts`，未来继续瘦身 |
| API model worker | root runtime / future worker adapter |
| external MCP transport | Bridge/Gateway transport module |
| Web AI DOM compatibility | WebMCP site adapter，不进入 Tool Layer |
| browser provider | Gateway/browser provider module |
| generic Sessions/AHP capability | upstream/Core layer，谨慎修改 |
| Nimora product UI | 优先 extension/contribution；缺 API 才考虑 thin Core shim |
| generated output | 不直接修改 |
