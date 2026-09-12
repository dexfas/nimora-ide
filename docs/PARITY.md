# Nimora IDE 功能对照验收

本文记录 Nimora IDE 与本机已安装 ShunCode `1.132.0` / 第一方扩展 `0.7.2` 的功能对照结果。验收日期：2026-09-12；本轮验收起始提交：`1c96391`。

## 结论

Nimora IDE 已经恢复并实测通过当前发行版的主要本地 AI IDE / Agent 能力，包括源码版启动、Chat participant、模型 Provider、Ask / Plan / Code 模式、IDE 工具 broker、Agent Host、MCP 文件工具、WebMCP 受管浏览器以及 Personal Edge Bridge。

目前不能把结论表述为“所有功能 100% 完全等价”。仍有一批依赖外部账号、私有/云端服务或完整人工 UI 回归的场景没有逐项验收，例如 Codex / Copilot 的真实账号登录和推理请求、Cloudflare/ngrok 公网隧道、远端服务、更新流程及所有 UI 边缘状态。

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

## 尚未逐项验证的能力

以下项目并不代表源码缺失，而是本轮没有用真实外部账号/服务做完整验收：

- OpenAI / 自定义 Base URL 的真实模型请求与各种错误状态。
- Codex OAuth 登录、退出、重新登录、状态页及真实推理请求。
- GitHub Copilot 账号授权与真实 Agent 推理会话。
- 多模型分支 / merge 在多个真实模型同时在线时的完整行为。
- Bridge 的 Cloudflare Quick Tunnel、Named Tunnel、ngrok 与公网 endpoint 轮换。
- Bridge 许可证旧路径；当前发行行为本身为 free access，许可和支付处于关闭状态。
- 远端 Agent / 隧道、更新流程、崩溃恢复、所有菜单/快捷键/UI 边缘状态。
- 全仓库严格 TypeScript / 测试层与发布快照的完全一致性；开发启动目前显式跳过重建核心 `src` 的 tsgo no-emit 检查，但仍执行实际 transpile、第一方扩展 typecheck 和 runtime build。

## 已知但非本次回归引入的日志项

- Agent Host 的 `vscode-userdata` `ENOPRO` 日志在已安装 ShunCode 中也存在，之后 Agent Host 仍继续初始化。
- Mermaid `legacyToolReferenceFullNames` proposal warning 在已安装 ShunCode 中也存在。

因此这两项目前记录为发行版已有行为，而不是 Nimora 重建新增回归。

## 当前判断

就已经能够离线/本地验证的主要生产链路而言，Nimora IDE 与当前 ShunCode 的功能恢复度已经很高，核心 Agent、文件工具、浏览器工具和 Personal Edge 均有真实运行证据。

若要把状态提升到“完整发行验收”，下一阶段应重点补齐真实账号与云端服务矩阵，而不是继续猜测本地源码是否缺失。
