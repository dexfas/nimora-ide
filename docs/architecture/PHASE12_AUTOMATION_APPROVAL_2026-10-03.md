# Phase12 — 网页 Worker 启动前统一授权

## 最新结果

工具错误强制停止、todos/progress展示和已收敛error恢复接线已经实现并加载。真实新请求set_todos/READ通过、PATCH参数错误后停在第三条调用，全部结果投递且未写文件。修复后全新报告补充目标已准备，等待启动前授权；不宣称连续成功。详见 PHASE12_CLOSEOUT_2026-10-03.md。以下18:15内容为历史检查点，后续更新以上述收尾记录为准。

## 历史结果（2026-10-03 18:15 CST）

SOURCE / regression / incremental BUILD PASS。18:07 通过公共 Restart Extension Host 正常加载，新版原三条 Mission 恢复、失败核实和 UI 入口 LIVE PASS。尚未提交新的 provider 执行，不宣称真实网页连续执行的无弹窗验收通过。

用户指出网页 AI 执行时反复出现权限窗口，打断自动化。生产代码的直接来源是 `createInteractiveCapabilityGrantResolver`：`workspace.apply-patch` 和 `terminal.run-command` 原先各在首次调用时询问会话授权。原机制已对同一能力/会话去重，但不同能力仍会分别中断任务。

## 实现

- 原 Project 的“运行实现与测试”入口合并需求审核与权限审核为一次“启动并授权连续执行”。只有用户选择“授权并启动”后才追加授权；取消不会授权或发送。
- 启动前通过 strict TaskRuntime 为当前 exact Worker 会话授予 `workspace.apply-patch`、`terminal.run-command` 两项既有 session 权限。读文件、命令输出、Task todos/progress 等保留原 metadata 策略。
- 所有能力和当前 Worker 归属先检查，再追加 durable grants。追加失败或自动执行策略保存失败均不发送 provider 请求；部分已追加的授权保留真实记录，可从现有权限管理入口撤销。
- workspace memento `nimora.workerSessionAutomationApprovals` 仅保存禁止执行中重复询问的 UX 策略，**不作为工具执行授权**。真正授权仍由 Task journal 的 capabilityId/version/session/attachedAt 检查。
- 同一会话重复调用两项已授权能力不再弹窗。相同会话身份的 journal replay 保留授权。更换、退役或重新绑定 Worker 不继承此授权，须启动前重新审核。
- 自动执行模式下，缺失或已撤销的授权直接拒绝，不在执行中打开授权窗口。可信宿主拒绝结果标记 `hostAuthorizationStoppedTurn`；Mission live driver 返回 terminal `error`，通过既有 iterator abandonment 清理/中断，阻止后续工具调用，不重新发送。
- 原有非预授权路径的逐项权限机制保持可用；未改浏览器权限、登录或网页验证码。
- 本地命令仍使用用户的系统权限，可以访问工作区外资源；合并授权界面明确说明。此改动不是命令沙箱，也不实现任意工具失败后硬停止。

## 验证

1. capability approval：批量授权后读 durable grants，写入/命令重复调用均零 prompt；journal restart 后仍有效；撤销和未授权能力零 prompt、拒绝并标记 stop；错误 Worker、未知能力、detach 不继承。
2. 实际生产 Practice 启动 callback：取消零 grant/零 send；preapproval 或策略保存失败零 send；输入身份先持久化再发送，原 root consumed input 保留。
3. 实际 Mission live driver + WorkerSessionManager：预授权拒绝后 provider 的第二条工具调用未消费；返回 error；canonical interrupt 一次。
4. existing capability grants/policy、web Worker stack、Worker abandonment regression PASS。
5. extension typecheck、canonical `--incremental` build、scoped diff check PASS。

最终磁盘 bundle SHA256：`B9011A11AA67AFDC3D69FDBC108C0455B53977AA0DEED1E8D0F8B58CF7283DE4`。首次授权修复构建的 D6A40A9F 是历史版本，后续增加恢复接线；当前激活由新版公开行为证明，未读取内存私有运行时或声称精确内存 hash。

## 同一 Project 恢复和失败核实

原 Project 的 Practice 请求已消费，24 条执行记录包含 4 条已知失败，全部结果已投递。新增路径核实失败的确切 durable fingerprint，只允许新的目标审核，不重放旧调用或把失败改成成功。UNKNOWN、pending/abandoned delivery、重复调用观测、无匹配 origin/result 和仍运行的 provider 不能通过核实。

原页面恢复 helper 现在支持原 root/Coordinator 加一个 exact Practice child。逐个通过 canonical owner 的 process-death proof 回收旧归属、按原页面 candidate 绑定并保存每一步；部分失败仍留在 recovering 状态，不自动重试。只恢复结果已收敛的任务，保留原 dispatch identity、consumed goal/input、Task execution 及失败历史。

18:07 旧 EH29924 正常 code0 退出，新版启动；原三张 DeepSeek 页面共享仍有效。公开恢复命令实际通过：当前 Coordinator `22e5ab3c-134c-4fd4-b2b7-692bbf650ef2`、root Target `81e15a31-e340-4a62-a31d-3395798026fe`、Practice `01e8bceb-c84f-4cfd-a132-a9cba3cfb8e0`。Attached24/Retired21，Task Created 仍3；总执行27/投递27（原 root READ3、Practice24）不变，未发送新的工作请求、未写交付文件、未追加权限。

公开结果核实保存失败 fingerprint `886aab35242d3655e285d2f2e97a90859e854048c9d93add40296803914a7e0c`，failureCount4。Nimora 产品页面已显示原“个人任务管理器项目”及“继续执行 Mission 的新目标”，失败列表仍可见。证据位于 `.build/phase12-current-takeover-20261002/automation-restored-20261003.json`、`automation-reconciled-20261003.json`、`automation-restored-ui-20261003.txt`。`automation-durable-preflight-20261003.json` 仅为只读结构预检，其 simulated orphan lookup 不是 machine-death proof；实际 owner 证明来自公开恢复路径。

## 剩余工作

使用一条全新已审核目标验证真实网页连续执行、Task todos/progress 与业务测试。启动授权仍由用户在产品中一次确认，未代点任何 security permission。任意工具错误后的强制停止、文件操作边界/命令沙箱、进度展示、正式语义验收和打包尚未完成。Phase11 core CLOSED 不变，Phase12 仍 OPEN。
