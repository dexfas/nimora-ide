# AgentHost Mission Worker 接线与验证（2026-10-06）

现有 Copilot CLI backend 已接入统一 Mission Worker pool 的源码生产路径。可用性要求新版 Workbench DTO bridge 和服务端共同支持 client-tool scope v1，且当前已发现所选 Copilot 模型。旧服务器、新旧进程混用、缺失协议声明、未知版本和 Claude/Codex backend 均保持 unavailable。真实账号/模型现场验收尚未完成，不能把模型桩或 SDK 事件模拟当成真实 Provider 验收。

## 执行边界

Core 使用已有 config schema 和 action `_meta` 承载通用协议，没有修改生成的 AHP 文件。服务端 root schema 的只读、单值版本声明独立于界面版本；配置值不能冒充 schema 声明。会话要求 fresh Copilot session、一个指定 client、冻结的对象工具 schema；禁止导入、fork、恢复旧 context、额外 customizations 和运行时修改工具/owner。

Copilot SDK 只获得 exact `custom:<name>` allowlist，排除 builtin/MCP 工具，禁用 configuration/file hooks/MCP apps/extensions、tool search、plugins/skills/instructions 与 custom agents。SDK permission callback 拒绝其它执行；客户端工具 handler 仅产生带 scope/client/turn/call 身份的 host request。本地 bang command、SDK slash command 和普通 Chat UI 的重复执行支路被阻断。

扩展 materializer 继续通过原 WorkerAssignment/WorkerSessionManager；host-requested occurrence 继续进入现有 Mission capability grant、路径策略、durable execution 和 delivery owners。原 `AgentHostWorkerAdapter` 的普通 native observations 保持 observed，不会重放已经由原生 SDK 执行的工具。

结果提交在 dispatch 前消费一次身份。客户端 action echo 不确认送达，只有该会话 SDK 的服务端 completion receipt 才确认；桥独立接收 receipt，避免 send pump 与结果等待互锁。30 秒未收到 receipt 明确为 delivery unknown，不重试原执行。取消、owner 漂移、输入/结果重放和 schema 漂移拒绝。桥限制 32 logical sessions、每 session 512 queued events/4 MiB，poll 单飞。

## 证据与限制

- `scripts/shuncode-agent-host-client-tools-smoke.mts`：使用真实桥与 AHP 模拟连接，验证服务端缺协议拒绝、fresh allocation、唯一 host request/提交、echo 与 SDK receipt 分离、no-replay、schema drift、取消、listener 释放。
- `copilotSessionLauncher.test.ts`：实际 launcher 对 SDK 的 allowlist/options 投影，以及恢复/多 client/工具漂移拒绝。
- `copilotAgentSession.test.ts`：真实 session/wrapper 的 SDK 事件转换和 handler/result/receipt 路径；模拟 SDK 事件，不是外部模型。
- `agentService.test.ts`：真实 service 的 scope 持久状态、客户端 action rejection envelope、other-client/fork/peer 拒绝、本地 command 支路阻断；数据库相关单元用例保持内存 SQLite。
- `shuncode-component-integration-smoke.mts`：真实 production candidate/materializer/command adapter，旧 ABI/未知 ABI/错误 model 拒绝，Copilot 可选、其它 native backend 不可选。

本轮没有发送新的真实 Provider 请求，没有创建或重放历史 proof 身份。新 Beta 包及完整构建/测试证据见 `CORE_BASELINE_RECONCILIATION_2026-10-05.md`。重启后丢失内存桥句柄时拒绝旧句柄，不自动重建或回放会话；后续 Native succession 必须由原 Mission owner 分配 fresh Worker。其它 backend 若要开放，需要独立实现和验证同等合同。

R3 实际桌面启动发现并修复 Node bootstrap 读取 `vscode-userdata` 而缺 provider 的问题：改用同一默认配置目录的 `appSettingsHome` file URI。管理 IPC 的 `agentHost` 连接不提供 renderer reverse proxy/BYOK channel，现明确跳过该连接；真实窗口连接仍正常注册。实际 NativeEnvironment + 内存文件系统设置加载/网络回归 8 passing，R3 启动不再出现这两处错误。真实 Root server discovery 已证明 v1；SDK 子进程启动与零旧会话可观测，但 modelCount=0，未获得新原生模型工作验收。
