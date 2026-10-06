# Nimora UI 与发行包收尾 — 2026-10-07

本轮将已经完成的 Product Shell 设计与 R19 后端修复合并。保留工作、项目管理、历史、AI 资源、设置的布局，不改 Mission、Worker、工具权限或正式完成的 ownership。

## 用户可见修正

- 长操作的等待提示跟随宿主实际开始/结束，跨页面和定时刷新保留。处理期间允许阅读导航，重复执行被拒绝，不排队、不中途恢复启动按钮。
- 失败原因同时进入页面反馈与原生通知；错误文本安全转义。只有新的显式操作才清除旧反馈，不自动重试。
- 自动刷新保留同一页面/项目/任务的滚动位置、展开详情和搜索框焦点，切换对象时不会套用旧阅读位置。
- 首页、设置页提供打开单个项目文件夹与原生信任审核入口。多文件夹工作区不显示为自治已就绪；权限显示“按任务确认”，不假定已有授权。
- AI 资源页解释网页/API 首次配置、本机通道无需公网桥、外部 MCP 连接边界与 API 无严格金额上限。资源偏好明确只用于后续工作。
- 未结束 Mission 不再等同正在运行；当前运行依据本 Mission 的 live Worker。完成候选与未知执行分别显示审核/核实状态；UNKNOWN 和待人工事项优先于保留的完成候选。
- 整体进度分别显示正式结束的任务与完成的待办，已归档任务不会因待办数为零显示成“已完成 0”。
- 随包 README 更新为中文首次使用说明与准确的 Beta 使用边界。

## 验证范围

第一方 typecheck、compile 与 39 项原有集成回归通过。新增宿主测试覆盖延迟操作、重复点击、导航与刷新、失败反馈、原生信任入口、未启动/运行状态与终态计数。两个历史测试更新为新 UI 文案，UNKNOWN 零 assignment/send 和网页准备不遮挡页面的行为断言保留。

48 个真实 Edge 浏览器呈现检查通过：1440/900/390 宽度、深浅主题、空白/资源/待启动/运行/完成/项目管理/降级/失败状态，检查脚本错误、水平溢出、等待期间导航、宿主结束反馈和刷新阅读位置。测试使用隔离 fixture，真实 Provider 调用为零。

完整标准 Windows desktop 构建已通过，Core 实际完成 desktop bundle 与 syntax check。其后只修改 Extension 的阅读位置保存，通过官方非原生 Extension 刷新和 CI packaging 生成最终目录；没有手改发行 bundle。使用已记录的 recovered-tree Core strict typecheck 兼容开关，不宣称完整 Core strict typecheck 通过。

最终目录：`C:\Users\devil\Documents\Ai\shuncode\VSCode-win32-x64-ui-release-20261007`。

归档：`.build/releases/Nimora-Beta-Windows-x64-20261007-UI-Release.zip`，372915475 bytes / 5995 entries；SHA256 `20bc70fcd7163ea394b53485c1a965c92f9c04dc4836869b1170ab8ed793d9ba`。CRC、完整回解、关键文件哈希、source/package UI 与 Extension 一致性通过；敏感 profile 文件名扫描为零。Extension SHA256 `24b45dc5054628ec99071026073db396d8a5ed106a46e6cee320a046dd0add00`。

最终目录 portable smoke 已通过：发行 exe 的 embedded Node、随包 Gateway 依赖、rg/native helper 与 Windows certificate native load 均通过，不依赖源码 checkout。新建隔离用户目录的真实桌面启动也通过：第一方 Extension 激活、实际 Webview 首次引导、AI 资源导航，以及宿主重新读取后的阅读位置恢复。0 Task / 0 workspace、没有模型请求、没有代点原生授权。中间候选预览以公开 closeWindow 正常关闭，最终版预览保留。

最终 ZIP 完整回解后的 portable smoke 也已通过，结果为 `release-zip-portable.json`。证据：`release-package-report.json`、`release-portable.json`、`desktop-release/packaged-ui-report.json`、`preview/browser-report.json`、`runtime-regression-final.json`，均位于 `.build/nimora-ui-closeout-20261007`。

## 仍然独立的产品资格门

本轮是 UI/整合发行验证，不重播 R19 已完成任务，也不代表新包重新完成账号现场验收。DeepSeek 网页两轮项目及 API 跨 carrier 正式完成的历史证据保留。混合 Provider/多 Practice 并行全链、其它账号与通道、Native 模型、网站会话归档以及 Stable OS sandbox 资格仍按各自证据判断。

API Worker 内部模型调用次数硬上限与严格金额预算尚未补齐；外层自治最多 8 轮不等于单 Worker 的调用硬上限。发行仍为有人监督的 Beta。

## 证据与回滚

`.build/nimora-ui-closeout-20261007` 保存修改前 UI/显示 helper/README 快照、测试、完整构建日志及实包核对。发行输出使用独立目录，R19、Program Files 与 current release 指针不改。回滚使用保留的旧包/快照，不清空用户任务、完成 latch、密钥或历史。
