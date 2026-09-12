# Process Architecture

## 1. 当前进程图

```text
Windows / macOS / Linux
│
├─ Electron Main
│  ├─ Workbench/Window lifecycle
│  └─ lazy spawn → Core Agent Host UtilityProcess
│
├─ Renderer / Workbench
│  ├─ Editor / Chat / Sessions / UI
│  ├─ LocalAgentHostServiceClient
│  └─ MessagePort ⇄ Core Agent Host
│
├─ Extension Host
│  ├─ extensions/shuncode
│  │  ├─ Native Chat / LM Providers
│  │  ├─ IdeToolBroker
│  │  ├─ Bridge HTTP MCP server
│  │  └─ spawn → first-party Runtime child
│  └─ extensions/shuncode-webmcp (UI extension)
│     ├─ local HTTP :48322
│     └─ spawn → webmcp-gateway Node
│
├─ Core Agent Host UtilityProcess
│  ├─ AHP protocol + Management IPC
│  ├─ Copilot / Claude / Codex providers
│  └─ session/worktree/checkpoint/sandbox/git
│
├─ First-party Runtime child
│  └─ runtime/agent-host.js · JSON-RPC JSONL stdio
│
├─ Optional stdio MCP child
│  └─ runtime/mcp-server.js · MCP stdio · file tools only
│
├─ WebMCP Gateway Node
│  ├─ :48321 control/MCP
│  ├─ MCP client → Bridge
│  ├─ Playwright managed Edge
│  └─ Personal Edge broker
│
├─ Managed Microsoft Edge
│  └─ Gateway persistent profile
│
├─ User Personal Edge
│  └─ Personal Edge MV3 service worker → localhost :48321
│
└─ Optional cloudflared / ngrok
   └─ spawned by Bridge for public MCP exposure
```

## 2. Electron Main → Core Agent Host

`ElectronAgentHostStarter` 在需要时创建 `UtilityProcess`：

- type/name: `agentHost` / `agent-host`；
- entry: `vs/platform/agentHost/node/agentHostMain`；
- 将 shell env、Agent SDK 配置、OTel/telemetry 环境传入；
- 通过 `utilityProcess.connect()` 创建 MessagePort；
- Window 通过 `vscode:createAgentHostMessageChannel` 请求额外直连 MessagePort；
- dispose 时杀死并释放 UtilityProcess。

该生命周期属于 Code-OSS platform 层，适合继续承担需要进程隔离、session state、sandbox/worktree 的通用 agent substrate。

## 3. Renderer → Core Agent Host

`LocalAgentHostServiceClient`：

- 从 Electron Main 获取 MessagePort；
- `Protocol` channel 承载 AHP data plane；
- `Management` channel 保留 session/chat creation 等窄管理操作；
- 支持 root/session/chat/terminal/changeset state subscription；
- 暴露 session create/list/dispose、terminal、resource、MCP request 等能力。

远端 Agent Host 通过相同服务抽象走 remote proxy / WebSocket 等 transport。

## 4. Extension Host → First-party Runtime

`RuntimeClient.startProcess()`：

1. 找到 `extensions/shuncode/runtime/agent-host.js` 或开发 override；
2. `spawn(process.execPath, [entryPoint])`；
3. 设置 `ELECTRON_RUN_AS_NODE=1`；
4. cwd 为 workspace root；
5. stdin/stdout/stderr 全部 pipe；
6. stdout 每行是一个 JSON-RPC message。

Runtime 反向调用 Extension Host：

- `ide/tool/invoke` → `IdeToolBroker`；
- `network/fetch` / cancel → Extension Host 代理网络；
- `agent/trace` notification；
- `agent/checkpoint` notification。

这一进程目前服务 Native Chat，而不是 Core Sessions/AHP。

## 5. Extension Host 内 Bridge

Bridge HTTP server 当前**没有独立进程**：它在 `extensions/shuncode` Extension Host 内创建 Streamable HTTP MCP endpoint。

好处：可以直接调用 `IdeToolBroker` 和 workspace context。

代价：MCP transport、tunnel lifecycle、tool execution metadata、UI state 都与 Extension Host 生命周期绑定；Bridge 变复杂时会扩大扩展主进程职责。

## 6. cloudflared / ngrok

Bridge 根据配置启动外部 tunnel child process：

- Cloudflare Quick Tunnel：动态公网 URL；
- Cloudflare Named Tunnel：固定域名/本地端口；
- ngrok：历史/可选路径。

Tunnel 只是**transport exposure**，不是 Tool/Task/Runtime 本身。目标架构应让它成为可替换 transport module。

## 7. WebMCP UI Extension → Gateway

`extensions/shuncode-webmcp` 默认：

- 自身 HTTP: `127.0.0.1:48322`；
- Gateway: `127.0.0.1:48321`；
- 可通过 built-in browser LM tools 控制已共享 Integrated Browser page；
- 负责注入 page agent、page token 与 approval；
- 必要时 spawn `tools/webmcp-gateway/server.mjs`。

开发时安装版 ShunCode 与源码 Nimora 同时运行会发生固定端口竞争。这个问题在重建 DeepSeek E2E 时已经真实出现，属于开发隔离技术债务。

## 8. Gateway → Browser processes

Gateway 使用 Playwright 启动/复用 managed Edge persistent profile。该 Edge：

- 与 Integrated Browser 是不同进程/会话；
- 与用户日常 Personal Edge 也不是同一 profile；
- 由 Gateway 控制完整 DOM/evaluate/screenshot 等 browser tools。

Personal Edge 则不由 Gateway 启动。用户手动点击 MV3 扩展共享一个真实标签页，扩展通过 localhost register/poll/result 协议与 Gateway 通信。

## 9. 进程 ownership 表

| Process / service | 谁启动 | 谁停止 | 主要职责 | 当前 transport |
| --- | --- | --- | --- | --- |
| Electron Main | desktop bootstrap | app lifecycle | Window / platform / AgentHost starter | Electron IPC |
| Renderer | Electron Main | window lifecycle | Workbench / Chat / Sessions UI | IPC / MessagePort |
| Extension Host | VS Code | extension lifecycle | Nimora extension orchestration / IDE APIs | VS Code Ext API |
| Core Agent Host | Electron Main lazy starter | main lifecycle | session/provider/worktree/sandbox agent substrate | AHP + Management IPC |
| First-party Runtime | `RuntimeClient` | RuntimeClient | API model/tool loop | JSON-RPC JSONL stdio |
| stdio MCP | external caller/host | caller | file tools MCP | MCP stdio |
| Bridge HTTP server | ShunCode extension | extension/command | external MCP exposure | Streamable HTTP MCP |
| cloudflared/ngrok | Bridge | Bridge | public transport | tunnel process |
| WebMCP local bridge | WebMCP extension | extension | Integrated Browser page bridge | localhost HTTP |
| Gateway | WebMCP extension/manual | extension/manual | tool federation/browser provider | HTTP/MCP |
| Managed Edge | Gateway | Gateway | external browser tools | Playwright/CDP |
| Personal Edge extension | user/browser | browser | one-tab explicit sharing | localhost HTTP poll |

## 10. 目标原则

未来任何新增 background process 都必须有：

- 唯一 owner；
- 明确启动条件；
- 明确 shutdown；
- versioned health/hello；
- crash/reconnect 语义；
- 不与安装版/其他 workspace 使用硬编码全局端口冲突。
