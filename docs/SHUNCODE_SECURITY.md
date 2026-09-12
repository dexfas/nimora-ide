# ShunCode Security Notes

## Secrets

不要提交 API key、模型服务凭据、ShunCode Bridge route token、Cloudflare/ngrok token、浏览器 profile、Cookie 或登录态数据库。

WebMCP Gateway 从 `SHUNCODE_MCP_URL` 读取真实上游 MCP 地址；该值应保留在 Git 之外。

Personal Edge 源码只保留通用 localhost 开发配对值。正式打包时应同时替换浏览器扩展中的配对值和 Gateway 的 `SHUNCODE_PERSONAL_EDGE_TOKEN`。

## Local automation

WebMCP / browser tools 可以写文件、执行命令、点击网页和提交表单。除非明确完全信任当前页面和任务，否则应保留高影响操作审批。

已经成功执行的副作用工具，不得因为结果消息发送失败而自动重跑。

## Installed ShunCode

不要把 `C:\Program Files\ShunCode` 当作日常开发目录直接修改。应优先从本仓库构建或使用可回滚测试安装；如确实需要测试核心文件替换，先保留并验证可恢复备份。

源码开发启动器必须与已安装实例隔离。当前 `scripts/shuncode-dev.*` 使用：

- `.build/shuncode-dev-user-data`：开发用户数据；
- `.build/shuncode-dev-extensions`：开发扩展；
- `.build/shuncode-dev-shared-data`：开发 shared storage。

启动器还会清除继承的 `ELECTRON_RUN_AS_NODE` 和已安装 VS Code/ShunCode 的 IPC/extension-host 环境变量，避免源码 Electron 进程误接入当前运行中的安装版实例。

