# Nimora IDE

Nimora IDE 是一个基于 **Code - OSS / Visual Studio Code** 的开源 AI 编程环境。本仓库以 VS Code `1.132.0` 为上游基线，整理了一套现有 AI IDE 发行构建中可验证恢复的第一方源码，并把 WebMCP、Browser MCP Gateway 与 Personal Edge Bridge 一并纳入开源目录。

> **项目公开名称是 Nimora IDE。** 为保持与已恢复发行源码、扩展 ID、协议和运行时路径兼容，仓库中仍保留部分历史 `shuncode` / `ShunCode` 内部标识；这些兼容标识不代表公开项目名称。当前仓库是从现有发行安装包、随包 TypeScript 源码和 source map 重建的开源工作副本，不会修改本机已安装程序。

当前功能对照与实机验收结果见 [docs/PARITY.md](docs/PARITY.md)。

## 上游基线

- 上游：`https://github.com/microsoft/vscode`
- VS Code / Code - OSS：`1.132.0`
- 官方 `1.132.0` tag commit：`df53daabb18cd157bdb08c7f01c34df936cf12f4`
- 本机 ShunCode 产品版本：`1.132.0`
- ShunCode 第一方扩展版本：`0.7.2`
- Web MCP Bridge：`0.4.10`
- WebMCP page agent：`v20`

安装包 `product.json` 中的 `09533f921029d9d073c06e70f566ebe31e43cebc` 并不是 Microsoft VS Code 仓库可抓取的 commit，因此本仓库没有把它伪装成上游提交；重建依据与差异说明见 [docs/RECONSTRUCTION.md](docs/RECONSTRUCTION.md)。

## Nimora IDE / 已恢复发行增量

主要新增/修改内容包括：

- `extensions/shuncode/`：ShunCode 原生 Chat / Agent、模型提供器、Codex 登录、Bridge、MCP、LSP、终端与多模型能力。
- `src/agent-host.ts`、`src/mcp-server.ts`、`src/file-tool-registry.ts` 等：从随包 source map 恢复出的 ShunCode Agent Runtime 与工具层源码。
- `product.json` / `package.json`：ShunCode 品牌、URL scheme、Open VSX、API proposals 与去除默认 Copilot Chat 集成等产品配置。
- `extensions/shuncode-webmcp/`：给普通 AI 网页注入 ShunCode MCP 能力的 WebMCP Bridge。
- `tools/webmcp-gateway/`：WebMCP / Browser MCP Gateway，包含 gateway-managed Edge 与 Personal Edge 的网关层。
- `extensions/shuncode-personal-edge-bridge/`：用户主动共享单个日常 Edge 标签页的 Manifest V3 扩展。

架构图和端口说明见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。

## 目录

```text
extensions/shuncode/                      ShunCode 第一方 VS Code 扩展源码
extensions/shuncode-webmcp/               WebMCP VS Code 扩展
extensions/shuncode-personal-edge-bridge/ Personal Edge 浏览器扩展
tools/webmcp-gateway/                     WebMCP / Browser MCP 网关
src/agent-host.ts                         Agent Runtime
src/mcp-server.ts                         文件工具 MCP server
src/file-tool-registry.ts                 文件工具注册与调用
src/ide-tool-definitions.ts               IDE 工具定义
docs/                                     ShunCode 开源与架构文档
```

## 开发

Code - OSS 主体仍遵循 VS Code 上游开发方式。当前 `.nvmrc` 要求 Node.js `24.18.0` 或更新的 Node 24 版本。首次安装依赖建议使用 lockfile：

```powershell
npm ci
```

Windows 下可以直接准备完整源码开发环境：

```powershell
.\scripts\shuncode-dev.bat --prepare-only
```

启动隔离的源码开发实例：

```powershell
.\scripts\shuncode-dev.bat --new-window
```

开发启动器会把用户数据、扩展和 shared storage 分别放在 `.build/shuncode-dev-user-data`、`.build/shuncode-dev-extensions`、`.build/shuncode-dev-shared-data`，并清除从已安装 ShunCode 扩展宿主继承的 Electron / VS Code IPC 环境变量，因此不会复用已安装实例的开发状态。

ShunCode 第一方扩展和 Runtime 可以独立验证：

```powershell
npm run typecheck-shuncode
npm run compile-shuncode
npm run test-shuncode-runtime
```

如果 Electron 原生绑定不存在，开发启动器会调用 `npm run rebuild-shuncode-native` 定向重建直接 native dependencies。完整构建说明、当前严格类型检查状态与已验证范围见 [docs/BUILDING.zh-CN.md](docs/BUILDING.zh-CN.md)。

WebMCP Gateway：

```powershell
cd tools/webmcp-gateway
npm install
$env:SHUNCODE_MCP_URL = "https://your-shuncode-bridge.example/mcp/<route-token>"
npm start
```

不要把真实 `SHUNCODE_MCP_URL`、route token、API key、Cloudflare/ngrok token、浏览器 profile 或登录态提交到仓库。

## 安全边界

这个开源副本刻意不包含：

- `browser-profile/` 和任何真实浏览器登录数据；
- WebMCP 运行截图；
- 本机 ShunCode 用户目录；
- API key、Bridge route token、Cloudflare/ngrok token；
- `C:\Program Files\ShunCode` 中的已安装二进制快照；
- 历史 Workbench / preload 大型 patched/original 编译产物。

开发时优先修改本仓库，不要直接 patch 已安装 ShunCode。更多边界见 [docs/SHUNCODE_SECURITY.md](docs/SHUNCODE_SECURITY.md)。

## 许可证与归属

Code - OSS 上游代码继续遵循原仓库的 MIT License 和第三方声明，详见 [LICENSE.txt](LICENSE.txt) 与 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)。ShunCode 新增源码按仓库 MIT 条款公开；上游归属和重建说明见 [NOTICE-SHUNCODE.md](NOTICE-SHUNCODE.md)。

原 VS Code README 已保留在 [docs/UPSTREAM_VSCODE_README.md](docs/UPSTREAM_VSCODE_README.md)。

