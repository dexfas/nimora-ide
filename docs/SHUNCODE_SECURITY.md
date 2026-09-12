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

