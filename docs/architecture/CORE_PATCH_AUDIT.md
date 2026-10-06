# Code-OSS Core Patch Audit

## 2026-10-05 — Read-only AgentHost Worker discovery

The same integration also exposes optional `ChatSkill.enabled` through the existing proposed prompt-file API. Discovery previously returned loaded Skills without their disabled-file state. The MainThread DTO reads the existing `getDisabledPromptFiles(PromptsType.skill)` owner, ExtHost forwards only positive evidence, and Nimora defaults missing metadata to disabled. No separate enablement owner or implicit trust is introduced. This additive generic metadata hook can be removed when the upstream API carries equivalent current enablement; its three DTO/API transformations and disabled/missing-metadata cases need focused validation.

- Necessary boundary: stable/proposed Extension APIs expose Chat models and Sessions UI, but no native AHP root/connection capability observation. The existing Workbench `IAgentHostService` is the owner; duplicating its session registry in the extension would be incorrect.
- Thin hook: `_agentHost.workerSnapshot` projects only provider labels/model IDs and connection state via the pure `agentHostWorkerDiscovery` adapter outside Core. It does not authenticate, create a session, send a turn, export transcripts/secrets, dispatch tools or alter approval policy.
- Mission pool: first-party discovery registers the AgentHost backend and candidate source. Every candidate remains `unavailable`: the current native `AgentHostWorkerAdapter` observes tools and its AHP contract cannot enforce Mission capability allowlists / host-requested delivery. This is a remaining execution gap, not a certification PASS. Missing hook/offline root is not interpreted as healthy.
- Validation: `shuncode-component-integration-smoke.mts` executes actual Skill MainThread/ExtHost mapping bodies (enabled/disabled/missing metadata), native root whitelist/gated discovery, and mixed-pool assignment is covered by the real API Runtime E2E. All PASS; four modified Core source files transpile PASS. Current `compile-client` is **not PASS** (1177 diagnostic); no diagnostic in the new hook/helper/DTO additions, while the old `extHostChatAgents2.ts:146` response stream still lacks `voiceProgress`. Existing fake-AHP tests remain semantic parity; no active desktop reload/native Provider E2E was performed. First-party build does not prove the Core hook is loaded in the user's desktop.
- Removal: delete the one read-only Workbench registration when an upstream Extension API supplies equivalent native AHP Worker metadata. Backend execution needs a separate real policy-capable connection contract; this hook deliberately grants none.

## 2026-09-30 — Exact browser page pairing repair

- Owner: generic BrowserView / Playwright substrate. The extension API and proposed APIs expose neither the IPC-to-CDP pairing nor its private queues; an extension adapter cannot repair a wrong underlying Page without bypassing the platform ownership boundary.
- Observed: restored internal browser sessions applied a ChatGPT composer observation to DeepSeek while the ordinary browser tool read the correct DeepSeek page. The old generated `_tryMatch` was independently reproduced assigning reversed Page events to the wrong View IDs. This proves FIFO is unsafe; missing historical target-ID telemetry prevents claiming it is the sole historical cause.
- Repair: add events carry the exact CDP `targetId`; Playwright pages obtain their page-session target info and match only that identity. The CDP proxy now honors page-session `Target.getTargetInfo` instead of returning the browser group identity. No URL, title, or FIFO fallback. Identity sessions detach, and late/closed/expired pages cannot be resurrected. Failed `addView` identity reads clean up their own registration.
- Gate: `npm run test-shuncode-playwright-page-identity` covers reversed events, same-URL tabs, both arrival orders, missing/ambiguous IDs, page-session query routing, unknown sessions, close/timeout during identity observation and detach. Focused identity/close/timeout tests and canonical transpile-client PASS. After the real machine restart, Source Dev discovery correctly lists DeepSeek and ChatGPT as separate candidates; this is live discovery evidence, not provider execution acceptance. Canonical Worker recovery and live execution remain pending.
- Removal: replace this patch when the upstream BrowserView substrate supplies equivalent target-identity matching and page-session CDP query behavior; retain the ordering/lifecycle regression.

## 1. 审计结论

Nimora 与 Code-OSS 的耦合**确实偏深**，但不能简单得出“Core Patch 都应该移除”的结论。

当前 Core 增量可以分成两类完全不同的东西：

1. **平台级 Agent substrate**：Agent Host、AHP、Sessions、worktree、sandbox、checkpoint、remote/local parity 等。它们本身具有长期价值，而且很多能力天然需要 Workbench/Main/Renderer/UtilityProcess 层权限。
2. **ShunCode 产品逻辑进入通用 Core**：Bridge UI、多模型 branch 状态、ShunCode provider/tool id 特判、产品命令 glue、特殊 Chat rendering。它们不是“必须在 Core 才能实现”的平台能力，长期应迁出或泛化。

因此推荐路线是：

> **Thin Core，不是 No Core。**

## 2. 审计证据与限制

### 已验证的 upstream delta

`src/vs/platform/agentHost` 相对 VS Code 1.132.0 的重建阶段审计：

- changed: 86
- added: 2
- total: 88
- 与安装版 ShunCode source maps: 88 / 88 exact

### 当前显式产品耦合扫描

当前 `src/vs/**` 中至少有 38 个 TypeScript 文件直接包含 `ShunCode` / `shunCode` / `SHUNCODE` 标识，主要集中在：

- NLS / product / dialogs；
- extHost Chat API；
- Workbench Chat actions/service/model；
- branch/merge；
- Bridge management/session UI；
- model management；
- tool rendering；
- chat input/list/widget。

这只是 marker scan，不等于完整 diff；但足以证明“AgentHost 88 files”不是全部产品 Core 增量。

## 3. Category A — Core Agent Host / AHP

**位置：** `src/vs/platform/agentHost/**` 及相关 Main/Workbench wiring。

### 做什么

- 独立 UtilityProcess Agent Host；
- local/remote transport；
- AHP state/action protocol；
- provider lifecycle；
- session/chat/terminal/resources；
- worktree isolation；
- sandbox；
- git/checkpoint/file monitor；
- Claude/Codex/Copilot SDK integration；
- BYOK LM bridge；
- telemetry/OTel；
- remote WebSocket endpoint。

### 为什么历史上存在

它不是为了 Nimora Bridge 临时加的一组 API，而是一整套 platform-level agent execution substrate。安装版 source maps 证明它是真实发行实现，不是开源恢复阶段臆造。

### 普通 Extension API 能否替代

不能等价替代。Extension 可以创建子进程和工具，但很难在不重新造整套平台的前提下获得：

- Workbench/Main 级 lifecycle；
- provider-agnostic Sessions integration；
- remote host parity；
- worktree/sandbox/checkpoint 深度集成；
- shared state/action protocol；
- 多 window direct MessagePort；
- platform filesystem/session services。

### 分类

**Keep / Upstream-first / Minimize Nimora-specific changes**

以后原则：优先跟随 VS Code upstream Sessions/AgentHost 演进；Nimora 不在这里加入具体 WebMCP/Bridge/DeepSeek 业务。

## 4. Category B — Sessions / Agents Window

**位置：** `src/vs/sessions/**`。

### 做什么

- provider encapsulates compute environment；
- session/workspace/chat abstraction；
- local/remote session provider；
- model/mode/permission/isolation/worktree controls；
- chat tabs；
- lead/worker chat；
- quick chat / archive / read state。

### 是否属于 Nimora 产品能力

它是非常接近 Nimora 未来 Task/Worker UI 需求的通用 substrate，而不是应当丢弃的“旧 Agent Panel”。

### 分类

**Keep + Reposition**

未来用户概念可从 “Agents Window” 演化为 Task Center / Work Sessions；底层 provider/session primitives 尽量复用，不重新造一套窗口框架。

## 5. Category C — ExtHost / proposed Chat API shims

**代表位置：**

- `src/vs/workbench/api/common/extHostChatAgents2.ts`
- `extHostTypes.ts`
- `extHostTypeConverters.ts`
- `languageModelToolsService.ts`

### 当前作用

让第一方扩展访问默认 participant、私有 Chat metadata、model provider、tool presentation 等当前公开 API 不足的能力。

### 判断

这类 patch 的必要性要逐项看“公开/proposed API 是否已经覆盖”。如果 Nimora 只是因为缺一个窄能力而修改几十处 Chat Core，应该收缩为小接口。

### 分类

**Keep minimal shim / Reduce**

目标：建立 `NimoraWorkbenchAdapter`（概念名），所有必须的 Core hook 通过少量 typed API/command facade 暴露，禁止业务模块继续直接散入 Chat internals。

## 6. Category D — Multi-model branch / merge in Chat Core

**代表位置：**

- `chatBranchService.ts`
- `chatBranchActions.ts`
- `chatExecuteActions.ts`
- `chatInputPart.ts`
- `chatListRenderer.ts`
- `shunCodeMultiModelWidget.ts`

### 当前作用

把同一轮不同模型回答表示为 Chat request variants，支持：

- branch send；
- prev/next；
- adopt；
- merge summary；
- canonical/active variant；
- branch badges；
- merge model settings。

持久状态又由 extension `BranchStateStore` 管理，并通过 `shuncode.branch.*` command 与 Core 交互。

### 问题

能力有价值，但领域建模错位：

> “多个 AI Worker 的候选结果/评审/合并”被编码成了 Chat renderer 的 branch 特例。

这让 multi-model 与 ChatModel 生命周期紧耦合，也无法自然服务 Web AI worker、后台 Task、非 Chat artifact。

### 分类

**Replace domain + Migrate UI**

未来由 Task Runtime 的 Worker Attempt / Candidate / Review / Merge 表达；Chat 只渲染这些结果。迁移完成前保持现有行为以兼容用户数据。

## 7. Category E — Bridge UI in generic Chat Core

**代表位置：**

- `shunCodeBridgeSessionView.ts`
- `shunCodeBridgeWidget.ts`
- `chatViewPane.ts`
- `chatActions.ts`

### 当前作用

- Bridge start/stop/status/health；
- tunnel/provider/config；
- activity/tool-call timeline；
- todo/progress；
- open file/diff/terminal；
- persistent Bridge mode；
- external-client output-only session。

### 问题

Bridge 是连接能力，不应该成为 Chat View 的特殊运行模式。Core 通过大量 `shuncode.bridge.*` command ID 读取 extension state，是典型 ownership 反转。

### 分类

**Move out of generic Chat Core**

推荐：

-连接与 tunnel 配置 → Connections / Settings；
- external tool execution/progress → Task execution timeline；
- file/diff/terminal actions → generic artifact/execution presentation；
- Chat 不再切换成 “Bridge session”。

## 8. Category F — ShunCode-specific model management in Core

**代表位置：** `chatModelsWidget.ts`、model picker、languageModels。

### 当前表现

Core 直接执行：

- `shuncode.codex.login/logout/relogin/getStatus`
- `shuncode.testApiEndpoint`

以及对 ShunCode provider/model 做产品特判。

### 分类

**Replace with provider metadata / contribution contract**

Core model UI 应只认识 generic provider capabilities：authentication actions、config editor、health/test endpoint、reasoning options。具体 command/provider 名称由 extension/provider contribution 提供。

## 9. Category G — ShunCode-specific tool UI in Core

**代表位置：**

- `chatToolInvocationPart.ts`
- `shunCodeChatToolProgressPart.ts`
- `chatListRenderer.ts`

### 当前表现

通过 `toolId.startsWith('shuncode_')` 和 `shuncode.chat.bridgeStyleUI` 特判视觉；文件 diff、terminal 等 actions 又调用 Bridge command。

### 分类

**Generalize then migrate**

保留“结构化 tool progress / file diff / terminal link”体验，但把判断条件改为 generic presentation metadata/artifact contract，而不是品牌/tool-id prefix。

## 10. Category H — Product/NLS/branding bootstrap

**代表位置：**

- `src/vs/platform/product/common/product.ts`
- `src/vs/base/node/nls.ts`
- `shunCodeLanguagePackBootstrap.ts`
- dialogs product behavior。

### 判断

发行版 branding、application id、data folder、server name 和 first-launch bundled language pack 都属于产品 carrier 层，不能完全由 workspace extension 负责。

### 分类

**Keep minimal product patch**

要求：与 AI Runtime 业务严格分开；以后升级上游时可单独审计。

## 11. Core Patch 决策矩阵

| 类别 | 当前价值 | Extension 可完全替代 | 目标分类 |
| --- | --- | --- | --- |
| AgentHost/AHP | 极高 | 否 | Keep / upstream-first |
| Sessions foundation | 高 | 否/不值得重造 | Keep + Reposition |
| narrow proposed API | 高 | 部分 | Reduce to thin shim |
| Multi-model Chat branch | 高能力/错位置 | 是，需 Task domain | Replace + migrate |
| Bridge Chat UI | 中/错位置 | 是 | Move |
| provider-name model UI | 中/错位置 | 是 | Generalize/remove |
| ShunCode tool renderer | 高 UX/错耦合 | 大部分 | Generalize/remove brand special-case |
| Product/NLS carrier | 必要 | 否 | Keep minimal |

## 12. Core Patch Definition of Done

未来每个新的 `src/vs/**` Nimora patch 必须在 PR/ADR 中回答：

1. 为什么公开 Extension API 做不到？
2. Proposed API 是否足够？
3. 是否可以只加 generic hook，而不加 Nimora product logic？
4. 上游升级冲突面有多大？
5. 对应测试是什么？
6. 如果未来 upstream 提供等价 API，如何删除该 patch？

没有答案时，默认**不进 Core**。

## 13. Phase 11 Repair WO#1F — Fixed WebMCP internal browser operation seam

**状态：** Phase 11 Cognition fresh reconciliation 已 ACCEPT Repair WO#1F；`P11-WO1-R6 = CLOSED`。这里记录 Core patch 必要性与升级面；**WO#1 仍未接受**，其剩余 authority 仅是 real Coordinator replacement + final ChatGPT native-MCP live proof。

### 为什么公开 / proposed Extension API 不足

Phase 11 production WebMCP lifecycle 需要对 Human 已显式 Share 的**精确 browser pageId**执行两个固定动作：read-only resource observation，以及 selected-candidate exact connect。现有 Extension-visible browser execution入口是 `vscode.lm.invokeTool('run_playwright_code', ...)`；它是面向用户的 arbitrary Playwright JavaScript tool，`prepareToolInvocation()` 正确地产生 interactive confirmation。自动 Worker discovery/connect 没有合法 chat invocation token，因此不能靠伪造 token、全局 auto-approve、`trusted/internal` caller flag 等方式绕过确认。

Fresh source inspection 没有发现一个既能复用 integrated-browser `IPlaywrightService`、又能在不经过 LanguageModelToolsService confirmation flow 的 Extension API。重新造第二 browser runtime 会破坏 exact shared-page authority，也扩大升级/安全面。因此 WO#1F 采用一个窄 Workbench adapter，而不是弱化 `run_playwright_code` 的确认。

### Core 只承担什么

新增 `webMcpInternalBrowserOperations.ts` 只负责机械边界：

- exact `pageId` 必须仍存在；
- BrowserView 必须仍处于 `Shared`，且 `IPlaywrightService.isPageTracked(pageId)` 为真；
- operation 开始前 current href 必须与第一次 list/target 的 expected href 相同；
- first-party fixed policy 标记的 native-MCP bypass host 在任何 page execution 前拒绝；
- operation ID 只允许 `listSharedPages` / `observe` / `connect`；
- structured caller input 使用 allowlist，拒绝未知字段，不接受 caller-supplied `code` / `script` / `expression` / function source；
- bounded `IPlaywrightService.invokeFunction()` 与 `waitForDeferredResult()`；deferred continuation 绑定 exact operation/page/href，不能 replay 原 operation；
- fixed executable assets / policy 只能从已安装的 first-party `shuncode.shuncode-integrated-browser-bridge` extension location 读取。

Core 不知道 Project、Mission、Coordinator、Worker assignment、DeepSeek policy 或 host capability semantics。ChatGPT native-MCP host 列表也不硬编码在 Core，而由 first-party WebMCP policy JSON 所有。

### Product semantics ownership

WebMCP resource fields、site adapter、runtime v25、composer/auth/running eligibility、agent/runtime installation、allowed prime、post-injection/post-prime lineage/session-generation fences仍由 `extensions/shuncode-webmcp/**` 的 repository-owned fixed assets 实现。`observe` 只读取既有 href/origin/site/composer/auth/runtime/session/worker-turn facts，不 inject、不 prime、不 send、不读 provider transcript、不导航；fixture regression 的 observation mutation count 为 0。

普通 `run_playwright_code` 没有修改，仍保留原 `confirmationMessages`。WO#1F therefore adds no generic arbitrary-JavaScript privilege.

### Upstream alternative / 删除路径

当前 upstream-equivalent primitives 是 `IPlaywrightService` + BrowserView sharing/tracking；缺的是一个 Extension-safe fixed-operation facade。若未来 upstream 提供“exact shared page + fixed structured operation + bounded/deferred execution”的公开/proposed API，可删除此 Workbench adapter，并让 `shuncode-webmcp` 直接消费 upstream surface；不得退回 confirmation bypass。

### 升级冲突面

Core delta 被限制为：

- 一个 `src/vs/workbench/contrib/browserView/electron-browser/webMcpInternalBrowserOperations.ts` adapter；
- `browserTools.contribution.ts` 一处注册 wiring。

主要升级依赖：`IPlaywrightService` timed/deferred contract、`IBrowserViewWorkbenchService` known-view/model/sharing contract、`BrowserViewSharingState`、`IExtensionService` extension location 与 `IFileService`。WebMCP product assets/policy 的变化留在 extension，不继续扩散到 generic browser/chat Core。

### 当前验证证据

Practice 在当前 Reality 上已证明：focused WO#1F matrix PASS；新增 internal-operation regression 证明 arbitrary `run_playwright_code` confirmation retained、caller-controlled executable source = false、DeepSeek-like observation success / mutation=0、auth/composer/running/native-bypass fail-closed、stable exact-connect fixture success；既有 exact-connect race 8 cases PASS；WO#1E bounded/deferred regression PASS。

真实 source Development Host live validation 还发现并在 WO#1F 边界内修复了两个 adapter contract bug：一是 `CommandsRegistry` 的 `ServicesAccessor` 不能跨异步生命周期持有，因此 command 入口现在同步 capture 所需 services 后再进入 async helper；二是 `IPlaywrightService.invokeFunction(..., args)` 会把 `args` spread 到 compiled function 参数，因此 fixed operation callback 使用 `(page, payload)`，而不是再次读取 `args[0]`。两项均有直接 regression 覆盖。

最终 live read-only proof 使用 Human 已重新 Share 的真实 DeepSeek integrated-browser page `537252b3-fe6d-46bf-b24a-a735f86b8d2e`：production `workerListResources` 在 549ms 内成功返回 `site=deepseek`、`composerFound=true`、`isDeepSeekAuthPage=false`、`nativeMcpBypass=false`、`ready=true`、`resourceIdentity=7a09939449aee42ddb0cbad47eecf27338bb10912d5cba7a46e17f10319138f2`；随后 exact `workerProbeResource({ pageId })` 在 47ms 内返回同一 pageId 和同一 resourceIdentity。该 live proof 只执行 read-only list/probe；没有 `workerConnect`、provider send、Coordinator replacement、auto-share 或 ChatGPT target action。

Completion 前 fresh formal gate：12 个 affected focused suites PASS；从当前 `package.json` 动态发现并执行的 `test-shuncode-*` 为 58/58 PASS；`typecheck-shuncode` PASS；`compile-shuncode` PASS；ShunCode diagnostics = 0 error / 0 warning；`git --no-pager diff --check` PASS；branch = `main`；HEAD = `79ab464acd0eac9eb623e2f6df2a1276088ece19`；cumulative dirty entries = 114。Phase 11 Cognition 随后独立重放 current production read-only path：同一 exact DeepSeek page 的 `workerListResources` 在 51ms 成功、`workerProbeResource` 在 46ms 成功，resourceIdentity 精确一致；另有 Cognition-owned adversarial probe、12/12 focused、58/58 dynamic suites、typecheck/compile、diagnostics 0。基于这些 fresh evidence，Repair WO#1F 已 ACCEPT，`P11-WO1-R6` 已 CLOSED；这仍不等于 WO#1 已接受。

## 14. Phase 11 Repair WO#1G — Fixed post-connect WebMCP Worker control

**状态：** Phase 11 Cognition fresh reconciliation 已 ACCEPT Repair WO#1G；`P11-WO1-R7 = CLOSED`。WO#1 仍未接受，仅因为 final real provider/live evidence chain 尚未完成。

### 为什么继续复用同一个 Core seam

WO#1F 已建立唯一合理的 first-party fixed-operation facade：exact Human-shared / Playwright-tracked BrowserView + repository-owned executable asset + bounded/deferred `IPlaywrightService`。WO#1G 发现 post-connect `send / poll / interrupt / resolve / health / disconnect` 仍走 `vscode.lm.invokeTool('run_playwright_code', ...)`，因此正常 Worker lifecycle 会重新进入 interactive arbitrary-code confirmation。

Repair 没有增加任何 confirmation bypass，也没有新增第二 browser runtime。`_workbench.browser.webMcpInternalOperation` 只把 operation ID 扩展为当前 Reality 的：`listSharedPages / observe / connect / control`。`control` caller schema 仍是 fixed structured data；action 只允许 `send / poll / interrupt / resolve / health / disconnect`。caller 不能提供 executable source，也没有 `trusted` / `skipConfirmation` / fake invocation token / generic JavaScript field。

### Core 机械边界

Core 对 `control` 只新增：exact open pageId、Human-shared、Playwright-tracked、native-MCP bypass fail-closed、plain structured control payload、unknown action/field fail-closed、bounded `invokeFunction()`，以及 exact `operationId + pageId + structured control identity` deferred ownership。continuation 只能等待同一个 `deferredResultId`；changed/wrong deferred identity 拒绝；timeout/UNKNOWN 不 replay 原 operation。

Core 仍不知道 Project / Mission / Coordinator / Worker assignment / DeepSeek semantics。runtime v25、exact WorkerSession/sessionId、runtime/status/stored page-session compatibility、origin/site lineage、turn/input semantics及六个 control action 的语义仍由 first-party `extensions/shuncode-webmcp/webmcp-internal-browser-operations.js` 拥有。

普通 `run_playwright_code` 未被 WO#1G 修改，原 confirmation messages 仍在；没有 global/workspace auto-approve，也没有 generic privileged JavaScript command。若未来 upstream 提供 exact shared-page + fixed structured operation + bounded/deferred execution API，可删除此 Workbench adapter，而不是退回 confirmation bypass。

### Practice evidence

新增 `test-shuncode-webmcp-fixed-control` 直接证明六个 control action 全部不再调用 `run_playwright_code`，health read-only、send exactly once、poll exact inputId、wrong-turn interrupt zero side effect、resolve dedupe preserved、disconnect semantics preserved、deferred no-replay、UNKNOWN no-replay、full-path bounded、ChatGPT route untouched。affected focused suites 15/15 PASS；动态全部 `test-shuncode-*` 59/59 PASS；`typecheck-shuncode` / `compile-shuncode` / diagnostics 0/0 / `git diff --check` / `transpile-client` PASS。

Source Development Host reload 后，Practice 按 accepted WO#1D fresh machine owner-death proof canonically retired durable-only orphan `c019575f-82dc-4d4f-8ff7-2cc7a127668b`；Human 重新 Share existing authenticated DeepSeek page 后，canonical same-Mission assignment produced managedSessionId `03ba1b30-1515-4deb-ba8a-3dc2f68f2fe6` / adapterSessionId `5e921808-3d10-43de-8c87-fe12c971dc2a`, durable/live = 1/1, runtime v25/pageSession identity exact-match.

Repair acceptance 前唯一真实 post-connect control proof 是 `_shuncode.worker.web.health(current managedSessionId)`：42ms bounded return，`status=healthy`，page runtime v25，exact pageSessionId，`workerTurn=null`，pending deliveries/capabilities = 0；interactive arbitrary-code confirmation = none；real provider send = 0；ChatGPT action = 0。Practice did not execute real send/poll/interrupt/resolve/disconnect。

Phase 11 Cognition 随后独立 fresh replay 当前 production health：managedSessionId `03ba1b30-1515-4deb-ba8a-3dc2f68f2fe6` 在 46ms 返回 `healthy`，runtime v25，exact pageSessionId `5e921808-3d10-43de-8c87-fe12c971dc2a`，workerTurn/pendingDeliveries/pendingHostCapabilities 均为空/0。Cognition-owned adversarial probe另行证明 health mutation=0、send execution count=1、unknown action fail-closed、wrong session before-action reject、六种 control 全部不走 `run_playwright_code`、ordinary arbitrary Playwright confirmation retained、deferred owner 绑定完整 structured control identity 且 continuation 只等待同一 execution。fresh formal gate = 15/15 focused PASS、59/59 dynamic `test-shuncode-*` PASS、typecheck/compile/transpile-client PASS、diagnostics 0、diff-check PASS。基于这些 fresh evidence，Repair WO#1G 已 ACCEPT，`P11-WO1-R7` 已 CLOSED。
