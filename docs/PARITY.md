# Nimora IDE 功能对照验收

本文记录 Nimora IDE 与本机已安装 ShunCode `1.132.0` / 第一方扩展 `0.7.2` 的功能对照结果。验收日期：2026-09-12；本轮验收起始提交：`1c96391`。

## 结论

Nimora IDE 已经恢复并实测通过当前发行版的主要 AI IDE / Agent 能力，包括源码版启动、Chat participant、模型 Provider、Ask / Plan / Code 模式、IDE 工具 broker、Agent Host、MCP 文件工具、WebMCP 受管浏览器、Personal Edge Bridge，以及通过本地和 Cloudflare Quick Tunnel 暴露的外部 Bridge MCP 调用链。ChatGPT 原生 MCP 与 DeepSeek 网页 WebMCP 两条目标接入链也均已完成真实模型端到端验证。

目前不能把结论表述为“所有功能 100% 完全等价”。仍有一批依赖外部账号、特定云端配置或完整人工 UI 回归的场景没有逐项验收，例如 Codex / Copilot 的真实账号登录和推理请求、Cloudflare Named Tunnel / ngrok、远端服务、更新流程及所有 UI 边缘状态。

## 静态源码对照

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 生产 sourcemap 可恢复源码 | 通过 | 已安装发行版 `resources/app/out` 的 27 个 JS sourcemap 共覆盖 4,995 个唯一生产 `src/` 源码；当前仓库 4,995 / 4,995 与 `sourcesContent` 一致。 |
| Agent Host 发行增量 | 通过 | 相对官方 VS Code 1.132.0 的 86 个修改文件 + 2 个新增文件均与已安装发行版 sourcemap 中的源码一致。 |
| 第一方扩展 manifest | 通过 | `extensions/shuncode/package.json` 与安装版字节级一致，SHA-256 相同。 |
| 第一方扩展功能入口 | 通过 | 两边均为 25 个 commands、1 个 Chat participant、7 个 Language Model Tools、37 个 activation events。 |
| 第一方扩展 TS 源码 | 基本一致 | 24 个源码文件中 23 个字节级一致；`bridge-license-service.ts` 为重建兼容修正，保持当前“free access”运行行为，同时消除不可达代码导致的类型问题。 |

## 源码版真实启动对照

Nimora 使用独立的 `.build/shuncode-dev-user-data`、`.build/shuncode-dev-extensions` 和 `.build/shuncode-dev-shared-data` 启动，不复用安装版用户数据。

本轮源码启动后，安装版与 Nimora 最新日志中的以下成功标记逐项 **6 / 6 对应**：

| 功能 | 安装版 | Nimora |
| --- | --- | --- |
| Native Chat participant `shuncode.agent` | 通过 | 通过 |
| Native Language Model provider `shuncode` | 通过 | 通过 |
| 第一方 Ask / Plan / Code 模式 | 通过 | 通过 |
| IDE tool broker | 通过 | 通过 |
| Bridge 注册 | 通过 | 通过 |
| Custom agents 发现 | 通过 | 通过 |

Nimora 源码版启动时 Main、Renderer、Extension Host 和 Agent Host 均正常出现；Agent Host 建立协议并上报 Copilot / Claude provider 能力。这里验证的是 provider/runtime 启动与发现，不等同于已经完成对应云端账号的真实推理请求。

## MCP / 文件工具实测

使用 Nimora 自己编译出的 `extensions/shuncode/runtime/mcp-server.js`，在隔离临时文件上执行真实调用：

| 工具 | 结果 | 实测内容 |
| --- | --- | --- |
| `find_files` | 通过 | 成功定位仓库测试脚本。 |
| `read_files` | 通过 | 成功读取 README 并识别 `Nimora IDE`。 |
| `search_files` | 通过 | 成功搜索 README 内容。 |
| `apply_patch` | 通过 | 成功修改临时文件并验证磁盘内容，随后清理临时文件。 |

结果：MCP 核心文件工具 **4 / 4 通过**。

## WebMCP 受管浏览器实测

使用仓库中的 `tools/webmcp-gateway` 启动本地 Gateway，并通过 Streamable HTTP MCP 直接调用本地浏览器工具。

| 功能 | 结果 |
| --- | --- |
| Gateway 启动 / MCP transport | 通过 |
| `browser_open` 打开 `https://example.com` | 通过 |
| `browser_get_text` 读取页面正文 | 通过 |
| `browser_pages` 返回当前页面 | 通过 |
| `personal_edge_status` | 通过 |

注意：Gateway 在 `listTools` 时会合并上游 Bridge MCP 工具。开源仓库不会提交真实 `SHUNCODE_MCP_URL`，因此未配置上游地址时完整工具枚举会正确提示缺少上游配置；本地 browser tools 本身仍可直接调用并已通过 roundtrip。

## Personal Edge Bridge 端到端实测

为避免接触日常 Edge 登录态，本轮创建了位于 `.build` 下的独立临时 Edge profile，并加载仓库中的 `extensions/shuncode-personal-edge-bridge`。

验证结果：

| 功能 | 结果 |
| --- | --- |
| 开源扩展加载 | 通过 |
| 扩展 ↔ Gateway 本地配对与 heartbeat | 通过 |
| 共享普通 HTTP(S) 标签页 | 通过 |
| `personal_edge_navigate` | 通过 |
| `personal_edge_elements` | 通过 |
| `personal_edge_fill` | 通过 |
| `personal_edge_click` | 通过 |
| `personal_edge_read` | 通过 |
| `personal_edge_reload` | 通过 |

完整交互测试使用本机临时 HTTP 页面：输入框被填入 `Nimora`，按钮点击后页面内容实际变为 `Hello Nimora`；reload 后状态恢复为 `Waiting`。因此 Personal Edge 的读、元素发现、填写、点击、导航和重载链路均完成真实端到端验证。

## Bridge / 外部 AI MCP 端到端实测

本轮使用 Nimora 主扩展自身的 `BridgeManager` 启动真实 Streamable HTTP MCP server，再以独立 Node.js MCP Client 模拟“外部 AI 客户端”。客户端与 Nimora 进程完全分离，不直接调用扩展内部对象。

本地 Bridge 验证结果：

| 功能 | 结果 |
| --- | --- |
| Extension Development Host 中启动 Bridge 本地 smoke server | 通过 |
| 外部 MCP Client 建立 Streamable HTTP 会话 | 通过 |
| 工具枚举 | 通过，返回 12 个工具 |
| `list_directory` | 通过 |
| `read_files` | 通过 |
| `run_command` | 通过，实际输出 `BRIDGE_E2E_OK` |

外部 Client 实际看到的 12 个工具为：`apply_patch`、`find_files`、`read_files`、`search_files`、`list_directory`、`run_command`、`get_command_output`、`send_command_input`、`get_diagnostics`、`lsp`、`set_todos`、`report_progress`。

随后将隔离开发配置的 tunnel provider 切换为 `cloudflare`，由同一个 Bridge 启动 Cloudflare Quick Tunnel。`cloudflared` 成功完成 DNS、QUIC、HTTP/2 和 Cloudflare API 连通性预检，并建立临时 `trycloudflare.com` 公网 endpoint。独立 MCP Client 通过该公网 HTTPS MCP URL 回连 Nimora：

| 公网链路 | 结果 |
| --- | --- |
| Quick Tunnel 建立 | 通过 |
| 公网 MCP Client 工具枚举 | 通过，12 个工具 |
| 公网 `read_files` | 通过，成功读取 README |
| 公网 `run_command` | 通过，实际输出 `PUBLIC_BRIDGE_E2E_OK` |

因此 **外部 AI / MCP Client → 公网 HTTPS Tunnel → Nimora Bridge → IDE/MCP tools** 已完成真实端到端闭环。测试使用的 Quick Tunnel、源码 Nimora 进程和临时测试文件在验收结束后均已关闭/清理。

首次公网尝试时，隔离开发设置中残留的 provider 为 `ngrok`，而本机 ngrok 会话认证失败，因此该次启动没有建立公网 tunnel；这不影响随后 Cloudflare Quick Tunnel 的成功验收，也意味着 ngrok 路径仍应单独列为未验证项。

## ChatGPT / DeepSeek 外部 AI 实测

本轮进一步选择两类代表性接入方式做真实模型验收：ChatGPT 走原生 MCP；DeepSeek 网页端走 WebMCP 页面协议。

### ChatGPT 原生 MCP

当前 ChatGPT 会话直接通过连接到 Nimora 的 MCP 工具调用 `run_command`，Nimora 实际执行无副作用测试命令并返回 `CHATGPT_NATIVE_MCP_OK`。因此 **ChatGPT → 原生 MCP → Nimora tool layer** 已完成真实闭环，而不是仅由独立测试 Client 模拟。

### DeepSeek 网页 WebMCP

DeepSeek 使用已登录的真实网页会话完成测试。页面 Agent 获取到 37 个可用工具，其中包含 Nimora 的 `list_directory`、`read_files`、`run_command`、LSP / diagnostics 等工具以及浏览器工具。

验收中发现并修复了三个 DeepSeek / WebMCP 兼容问题：

1. WebMCP Extension Host 重启后会生成新的页面 token，而旧页面 Agent 曾只按版本号判断“已经注入”，因此可能继续持有旧 token并触发 `Invalid Web MCP page token`。现在页面 Agent 会同时校验 Bridge 地址与 token；配置发生变化时会停止旧 Agent 并重新注入。
2. DeepSeek 登录页的账号输入框曾可能被通用 composer 检测误判为聊天框。现在 `/sign_in`、`/sign_up`、`/forgot_password` 不会 prime WebMCP。
3. DeepSeek 对 JSON 工具请求连续出现生成中途截断。DeepSeek 现在使用专用行式协议（`id=` / `name=` / `arg.*=`），仍保留旧 JSON 协议给其他网页 AI；数组 / 嵌套参数使用 dotted path，长多行参数支持 heredoc。扫描器使用 `innerText` 保留 DeepSeek Markdown 渲染产生的换行。

真实 DeepSeek 回合验证结果：

| 链路 | 结果 |
| --- | --- |
| DeepSeek 接收 WebMCP 上下文与 37 个工具 | 通过 |
| DeepSeek 自主生成 `list_directory` 工具请求 | 通过 |
| WebMCP 自动解析并调用 Nimora `list_directory` | 通过 |
| 工具结果自动回灌 DeepSeek | 通过 |
| DeepSeek 根据真实结果确认 `README.md` 与 `docs` | 通过 |
| DeepSeek 生成带数组参数的 `read_files` 请求 | 通过 |
| `arg.files.0.*` 正确还原为嵌套 MCP 参数 | 通过 |
| Nimora 实际读取 README 第 1–4 行 | 通过 |
| DeepSeek 根据返回内容回答首个 Markdown 标题 `# Nimora IDE` | 通过 |

因此 **DeepSeek 网页模型 → WebMCP → Nimora MCP tools → WebMCP result → DeepSeek 继续推理/回答** 已完成真实端到端闭环。

本次为了在不修改安装版文件的前提下复用现有已登录 DeepSeek 内置浏览器会话，页面宿主使用了安装版 Integrated Browser 的只读 HTTP tool bridge，并通过 `.build` 下的临时页面适配器连接到源码 Nimora 的 Gateway / MCP。实际工作区工具执行发生在源码 Nimora。安装版与源码版默认都使用 `48321/48322`，因此两者同时运行时存在开发端口冲突；这属于并行开发环境限制，不影响单独运行 Nimora 时的 WebMCP 架构。

## 尚未逐项验证的能力

以下项目并不代表源码缺失，而是本轮没有用真实外部账号/服务做完整验收：

- OpenAI / 自定义 Base URL 的真实模型请求与各种错误状态。
- Codex OAuth 登录、退出、重新登录、状态页及真实推理请求。
- GitHub Copilot 账号授权与真实 Agent 推理会话。
- 多模型分支 / merge 在多个真实模型同时在线时的完整行为。
- Bridge 的 Cloudflare Named Tunnel、ngrok 与公网 endpoint 轮换；Cloudflare Quick Tunnel 已完成真实公网 MCP 回连。
- Bridge 许可证旧路径；当前发行行为本身为 free access，许可和支付处于关闭状态。
- 远端 Agent / 隧道、更新流程、崩溃恢复、所有菜单/快捷键/UI 边缘状态。
- 全仓库严格 TypeScript / 测试层与发布快照的完全一致性；开发启动目前显式跳过重建核心 `src` 的 tsgo no-emit 检查，但仍执行实际 transpile、第一方扩展 typecheck 和 runtime build。

## 已知但非本次回归引入的日志项

- Agent Host 的 `vscode-userdata` `ENOPRO` 日志在已安装 ShunCode 中也存在，之后 Agent Host 仍继续初始化。
- Mermaid `legacyToolReferenceFullNames` proposal warning 在已安装 ShunCode 中也存在。

因此这两项目前记录为发行版已有行为，而不是 Nimora 重建新增回归。

## 当前判断

就已经能够验证的主要生产链路而言，Nimora IDE 与当前 ShunCode 的功能恢复度已经很高，核心 Agent、文件工具、浏览器工具、Personal Edge，以及本地/公网 Bridge MCP 均有真实运行证据。

若要把状态提升到“完整发行验收”，下一阶段应重点补齐真实账号与云端服务矩阵，而不是继续猜测本地源码是否缺失。
