Nimora Beta / Windows x64 — 首次使用说明

1. 把整个发行包解压到可写目录，双击 Start-Nimora.cmd。
   不需要安装 Node.js、npm 或下载源码。请保留包内目录结构。
   启动器使用独立的 %LOCALAPPDATA%\Nimora 用户目录；历史 ShunCode 内部标识保留。

2. 点击左下角 Nimora；也可按 Ctrl+Shift+P，运行 Nimora: Open。
   打开单个项目文件夹，并在原生“工作区信任”页面审核该文件夹。
   空白首页和设置页提供打开文件夹、审核信任的入口。

3. 在“AI 资源”中选择一种方式即可：
   网页：打开 DeepSeek，登录并按提示“分享给 Agent”；新页面需分别授权。
   API：点击“管理 API 模型”，添加端点、模型、协议与密钥。
   密钥只填写在产品密码框中，由 SecretStorage 保存，不写入目标或聊天。
   然后在“执行偏好”选择 DeepSeek 网页或 API 全流程，首次可选择串行。
   本机网页/API 工作无需配置 Cloudflare；外部 AI 经 MCP 接入本机时才需要公网桥。

4. 从“项目”页新建项目，写清目标、允许修改的范围及验收要求。
   根据原生提示确认启动、费用与权限。取消不会产生授权。
   操作进行中可查看其他页面；重复启动不会排队执行。
   工作收敛后点击“审核并完成项目”，检查结果并确认正式完成。
   文件、决定、任务历史保留。同一项目可开始下一项工作。

命令面板入口：
  Nimora: Open
  Nimora: Manage API Profiles
  Nimora: Configure Worker Resources
  ShunCode: Open Chat（普通 AI 对话）

使用边界：
  这是有人监督的 Beta。API 调用会产生费用，目前没有严格金额预算上限。
  DeepSeek 网页两轮项目、DeepSeek API 自治及正式完成有历史真实验收证据；
  此包的 UI/构建验证不等于所有 Provider、混合并行与故障场景重新现场验收。
  登录、验证码、网页共享、执行授权、正式完成仍由你确认。
  执行结果不明时先核实原记录，不重复发送已消费的请求。
  进度报告不等于正式完成；退休 Worker 不等于删除网站聊天记录。
  Stable OS sandbox 认证仍未通过，不能作为无限制无人值守自动化使用。
