# Nimora IDE 源码构建

## 环境

本仓库当前基于 Code - OSS / VS Code `1.132.0`。根目录 `.nvmrc` 指定 Node.js `24.18.0`；上游 preinstall 允许同一 Node 24 主版本中不低于该版本的 Node.js。

推荐从干净仓库执行：

```powershell
npm ci
```

不要用 `npm install` 随意刷新 lockfile。VS Code 根仓库包含多个子工程，正常 `npm ci` 的 postinstall 会继续安装 `build/`、`remote/`、`extensions/` 和测试目录的依赖。

## ShunCode 第一方构建

```powershell
npm run typecheck-shuncode
npm run compile-shuncode
npm run test-shuncode-runtime
```

`compile-shuncode` 会生成：

- `extensions/shuncode/dist/extension.js`；
- `extensions/shuncode/runtime/agent-host.js`；
- `extensions/shuncode/runtime/mcp-server.js`；
- `extensions/shuncode/runtime/bin/rg.exe`（Windows）。

Runtime smoke test 已验证 Agent Host `runtime/hello`、MCP `listTools` 和通过打包后 ripgrep 执行的真实 `search_files`。

### 开发宿主运行时的增量构建

正在运行的 Extension Host 可能锁定原生 addon。此时使用完整的增量构建，避免先清空输出目录：

```powershell
node extensions/shuncode/esbuild.mts --incremental
```

该命令仍从源码生成 extension、agent-host 和 mcp-server；只有二进制内容哈希完全相同时才跳过复制。不同版本的锁定二进制仍会报错，不能据此声称已经更新。默认 `compile-shuncode` 保留清理行为；应在相关开发宿主停止后用于干净构建。增量构建通过不等于发行包或安装器验收通过。

## 完整桌面开发实例

Windows：

```powershell
.\scripts\shuncode-dev.bat --prepare-only
.\scripts\shuncode-dev.bat --new-window
```

macOS / Linux：

```bash
./scripts/shuncode-dev.sh --prepare-only
./scripts/shuncode-dev.sh --new-window
```

开发实例使用 `.build/` 下独立的 user data、extensions 和 shared data。它不会把 `C:\Program Files\ShunCode` 当作开发目录，也不会复用安装版的 shared storage。

在 Windows 实测中，从空 `out/` 开始的 `--prepare-only` 已成功完成 Code - OSS 主体 transpile、内置扩展编译、ShunCode typecheck / bundle 和 Runtime 构建；随后源码 Electron `42.7.1` 成功启动 main process、renderer、Agent Host 和 extension host，第一方 `shuncode.shuncode` 扩展完成 Chat participant、Language Model provider、IDE tools、Bridge 与三个内置模式注册。

## Electron 原生依赖

仓库 `.npmrc` 针对 Electron `42.7.1` 构建 native modules。若 native binding 缺失，开发启动器会执行：

```powershell
npm run rebuild-shuncode-native
```

该命令只重建已确认需要 Electron ABI 的直接依赖，避免直接执行根级 `npm rebuild` 时再次触发整个项目的 preinstall。Windows 开发启动器还会显式检查 `@vscode/policy-watcher` 与 `windows-foreground-love` 的 native binding；任一缺失时会自动触发这组重建。

## 当前严格 typecheck 状态

恢复出的发布生产源码已经通过安装版 source map 的 4,995 / 4,995 文件一致性审计，但 Code - OSS 根 `src` 中仍存在未进入发布 bundle 的测试、类型声明和外围入口与发布快照不同步的问题。因此：

- 默认 `npm run compile` 仍保留上游严格 tsgo no-emit 检查；
- `scripts/shuncode-dev.*` 仅在重建开发流程设置 `SHUNCODE_SKIP_CORE_TYPECHECK=1`；
- 该开关只跳过核心 `src` 的 no-emit typecheck，不跳过实际 JS transpilation，也不跳过 ShunCode 第一方扩展 typecheck。

这是一项显式的重建兼容措施，不应被解释为“所有上游测试和类型检查均已通过”。

## 已知发行版日志

## 2026-10-04 — Windows 独立桌面包（实际构建通过）

第一方生产 Gateway 必须先安装随附依赖；仅 stage 源码文件不足以独立发行：

```powershell
npm run stage-shuncode-webmcp-gateway-production
```

使用标准 `npm run gulp -- vscode-win32-x64` 完整构建。若 `out-vscode` 已由完整桌面 bundle 生成，后续第一方源码更新后应先刷新 `compile-non-native-extensions-build`，再运行 `vscode-win32-x64-ci`；CI packaging本身不重新bundle所有非原生扩展。

本机实测构建需要：

- 当前构建进程设置 `SHUNCODE_BUILD_INCREMENTAL=1`，避免清空运行中开发宿主锁定的相同原生helper；不允许跳过不同二进制的更新。
- 当前Node构建进程启用 `--use-env-proxy` 并指定实际HTTP(S)_PROXY。本机Windows代理为127.0.0.1:7897；其它机器需检查自己的配置。Electron下载与SHA256校验没有关闭。
- 当前构建PATH包含已安装SDK的signtool：`C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64`，不修改系统PATH。

标准packaging会**递归清理**父目录 `VSCode-win32-x64`。运行前核实精确绝对输出路径；发行实例运行时不要重打包其加载中的目录。不要对Program Files操作。

03:38最终 `vscode-win32-x64-ci` PASS。目录 `C:\Users\devil\Documents\Ai\shuncode\VSCode-win32-x64` 包含 `Start-Nimora.cmd`；启动器使用独立LOCALAPPDATA/Nimora数据目录，内部ShunCode标识保留。Gateway使用发行exe的embedded Node和随附production node_modules，无需PATH node.exe；实际portable smoke启动health验证PASS。扩展bundle source/package SHA256相同：67da8335c9fd4e4c8ba6d2a49d9aa69b5761d6954420d7e4d38c709caf7bfa82。

该构建不是安装器、签名发布或完整网页Project验收通过；详细范围与未通过门见 `docs/architecture/PHASE12_PROJECT_COMPLETION_AND_PORTABLE_2026-10-04.md`。

### 2026-10-04 — Phase13 productization bundle

Phase13 Productization 修改完成后实际执行：

```powershell
$env:SHUNCODE_BUILD_INCREMENTAL='1'
npm run compile-shuncode
```

结果 PASS：production Gateway 13 trusted assets 重新 staging，`agent-host.js`、`mcp-server.js`、`extension.js` 均从当前源码重新 bundle。

2026-10-05 又使用标准桌面链做了 Phase13 独立输出刷新，而不是覆盖可能仍被使用的旧目录：

```powershell
$env:VSCODE_PACKAGE_OUTPUT_SUFFIX='phase13-20261004'
$env:SHUNCODE_SKIP_CORE_TYPECHECK='1' # recovered-tree 已记录兼容门；实际 core transpile/bundle 仍执行
$env:SHUNCODE_BUILD_INCREMENTAL='1'
npm run gulp -- vscode-win32-x64
```

输出目录 `VSCode-win32-x64-phase13-20261004`。本次 `src -> out-vscode` 实际完成 24 个 desktop bundles、syntax check 和 resources copy，随后 Windows package / CI package 均 exit 0；因此 Phase13 的 Workbench strict sandbox core 也进入包内，不是只覆盖 ShunCode extension。目录级与 ZIP 全量回解后的 `scripts/nimora-portable-smoke.mjs` 都 PASS；source/package extension SHA256 同为 `f06122d4d7884b53938a4c0f8f3934a06e03189724d6be5e4e246b33c4243510`。

Phase13 归档：`.build/releases/Nimora-Beta-Windows-x64-20261005-Phase13.zip`，361891441 bytes，SHA256 `586e55524001998ef791b104682f23ce3ed46efda3b5e0942982b56789d4729f`。ZIP 回解 smoke 验证 packaged Electron Node、Gateway production dependencies、first-party rg/native helper、Windows certificate native load 和 source-checkout isolation；归档包含 `Start-Nimora.cmd` 与 `crypt32.node`，敏感 profile/db/env 文件名扫描 0 命中。该结果仍不等于外部 Provider E2E 或当前 Windows 主机 Stable sandbox live certification；详细安全门见 `docs/architecture/PHASE13_PRODUCTIZATION_2026-10-04.md`。


### 原有平台日志说明

当前安装版和源码开发版都会在 Agent Host 启动时记录 `vscode-userdata` provider 的 `ENOPRO` 日志，随后 Agent Host / Copilot CLI 协议仍继续正常初始化。Mermaid 内置扩展的 `legacyToolReferenceFullNames` proposal 警告也能在安装版日志中复现。这两项属于现有发行版行为，本仓库没有为了让 smoke log 更干净而擅自改变生产行为。


## 2026-10-07 — 最终 UI Release 独立 Beta 包

完整标准 `npm run gulp -- vscode-win32-x64` 实际完成 Core desktop bundle 与语法检查。UI 阅读位置最终修正后，使用官方 `compile-shuncode`、`compile-non-native-extensions-build` 和 `vscode-win32-x64-ci`，以独立 `VSCODE_PACKAGE_OUTPUT_SUFFIX=ui-release-20261007` 输出，未手改 bundle。保留本文件已记录的 incremental/recovered-tree Core strict typecheck 兼容门和仅构建进程的 proxy/SDK PATH，不改系统配置，不覆盖运行中的 R19/Program Files。

目录 `C:\Users\devil\Documents\Ai\shuncode\VSCode-win32-x64-ui-release-20261007`；归档 `.build/releases/Nimora-Beta-Windows-x64-20261007-UI-Release.zip`，372915475 bytes / 5995 entries，SHA256 `20bc70fcd7163ea394b53485c1a965c92f9c04dc4836869b1170ab8ed793d9ba`。source/package extension SHA256 同为 `24b45dc5054628ec99071026073db396d8a5ed106a46e6cee320a046dd0add00`。目录与完整 ZIP 回解 portable、新隔离 profile 的实际 UI、CRC/hash/隐私文件名扫描均 PASS；不依赖源码 checkout 的 Node/Gateway/native assets。39 集成回归与 48 界面检查 PASS。仍为 Beta，本轮未发送 Provider 请求或完成 Stable certification。详见 [收尾证据](architecture/UI_RELEASE_CLOSEOUT_2026-10-07.md)。
