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

该命令只重建已确认需要 Electron ABI 的直接依赖，避免直接执行根级 `npm rebuild` 时再次触发整个项目的 preinstall。

## 当前严格 typecheck 状态

恢复出的发布生产源码已经通过安装版 source map 的 4,995 / 4,995 文件一致性审计，但 Code - OSS 根 `src` 中仍存在未进入发布 bundle 的测试、类型声明和外围入口与发布快照不同步的问题。因此：

- 默认 `npm run compile` 仍保留上游严格 tsgo no-emit 检查；
- `scripts/shuncode-dev.*` 仅在重建开发流程设置 `SHUNCODE_SKIP_CORE_TYPECHECK=1`；
- 该开关只跳过核心 `src` 的 no-emit typecheck，不跳过实际 JS transpilation，也不跳过 ShunCode 第一方扩展 typecheck。

这是一项显式的重建兼容措施，不应被解释为“所有上游测试和类型检查均已通过”。

## 已知发行版日志

当前安装版和源码开发版都会在 Agent Host 启动时记录 `vscode-userdata` provider 的 `ENOPRO` 日志，随后 Agent Host / Copilot CLI 协议仍继续正常初始化。Mermaid 内置扩展的 `legacyToolReferenceFullNames` proposal 警告也能在安装版日志中复现。这两项属于现有发行版行为，本仓库没有为了让 smoke log 更干净而擅自改变生产行为。
