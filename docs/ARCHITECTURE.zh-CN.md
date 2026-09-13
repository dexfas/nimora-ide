# Nimora IDE 架构概览

> 本文保留为快速入口。完整的事实架构、进程图、协议、Core Patch 审计、目标架构和迁移计划见 [`docs/architecture/README.md`](architecture/README.md)。

## 1. 主体

```text
Code - OSS 1.132.0
  └─ extensions/shuncode
       ├─ Native Chat / Agent
       ├─ Model providers / Codex auth
       ├─ Agent Runtime client
       ├─ IDE tool broker / LSP / terminal
       └─ ShunCode Bridge (Streamable HTTP MCP)
```

Agent Runtime 的主要源码位于仓库根 `src/agent-host.ts`、`src/openai-agent.ts`、`src/file-tool-registry.ts`、`src/ide-tool-definitions.ts` 等文件。

## 2. WebMCP

当前 WebMCP Bridge 为 `0.4.12`，page agent 为 `v25`。v25 已把 parser/dedupe/delivery state 抽到 WebMCP Core，并把 DeepSeek/Generic 网页差异放进 Site Adapter；Integrated Browser 与由扩展启动的 Gateway-managed Browser 共用同一份 canonical page agent，仅 transport 分别使用 localhost HTTP 与 Playwright binding。Phase 5.2 又在 page runtime 上增加稳定的 Worker control surface（session/send/poll/interrupt），由第一方扩展通过命令桥接为 `WebMcpCommandTransport → WebWorkerAdapter → WorkerSessionManager`，page session id 作为 adapter session id 写入 Task worker-session journal。

```text
AI 网页（Arena / DeepSeek 等）
      ↓  page agent / MutationObserver
127.0.0.1:48322
      ↓  ShunCode WebMCP extension
127.0.0.1:48321?protocol=2
      ↓  WebMCP Gateway
ShunCode Bridge MCP
      ↓
真实 workspace / terminal / IDE tools
```

端口：

- `48322`：ShunCode WebMCP 页面桥默认端口，可用 `SHUNCODE_WEBMCP_CONTROL_PORT` 为源码/测试实例覆盖；
- `48321`：Browser MCP / WebMCP Gateway 默认端口，可用 `SHUNCODE_WEBMCP_GATEWAY_PORT` 覆盖；
- `48323` / `48324`：历史方案，不应作为新架构依赖。

WebMCP 页面监听使用页面内 `MutationObserver`，不采用持续高频 Playwright DOM polling。

## 3. 两个浏览器环境

WebMCP 明确区分：

1. ShunCode Integrated Browser：承载 WebMCP 聊天页并提供 ShunCode shared-page 工具；
2. 外部 Windows 浏览器环境：gateway-managed persistent Edge 与用户主动共享的 Personal Edge tab。

`browser_*` 操作 gateway-managed Edge；`personal_edge_*` 只操作用户在浏览器扩展中主动开启 `ON` 的单个普通 `http/https` 标签页。

## 4. Personal Edge Bridge

`extensions/shuncode-personal-edge-bridge/` 是 Manifest V3 扩展。它通过 localhost 与 gateway 通信，支持：

- 状态读取；
- 正文读取；
- 可交互元素枚举；
- 点击；
- 填写；
- 导航；
- 刷新。

交互类操作进入 WebMCP 高影响审批体系。扩展不提供任意 JavaScript 执行，不控制 `edge://` 特权页面。

## 5. 安全原则

- 工具执行和结果消息发送是两个事务；
- 结果回传失败不得自动重跑有副作用的工具；
- `apply_patch` / `run_command` 不做盲重放；
- WebMCP 高影响操作保留审批模式；
- 能通过用户级扩展完成的功能，不修改 ShunCode core；
- `Program Files` 安装目录只作为只读参考母版。

