# ShunCode Personal Edge Bridge

这个 Edge Manifest V3 扩展让 ShunCode WebMCP 控制**用户日常 Microsoft Edge 中主动共享的单个标签页**，从而直接复用该标签页原本的登录态、Cookie 和网站会话。

## 安装（一次性）

1. 在 Microsoft Edge 打开 `edge://extensions/`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”。
4. 选择本目录 `ShunCode-Personal-Edge-Bridge`。
5. 建议把扩展固定到工具栏。

## 使用

在你希望 AI 操作的普通 Edge 标签页上点击扩展图标：

- 徽章显示 `ON`：该标签页已共享给 ShunCode WebMCP；
- 再点一次：停止共享；
- 同一时间只共享一个标签页；
- 关闭共享标签页会自动取消共享。

当前 WebMCP 会获得：

- `personal_edge_status`：确认日常 Edge 扩展是否已连接、是否共享标签页，以及共享标签页的标题/URL。
- `personal_edge_read(max_chars)`：只读共享的普通 `http/https` 标签页，返回页面标题、URL 和可见正文文本。
- `personal_edge_elements(max_elements)`：只读列出可见交互元素的 selector / 文本 / role / placeholder 等安全元信息，不返回输入框当前值。
- `personal_edge_click(selector)`：点击共享标签页里的一个元素。
- `personal_edge_fill(selector, value)`：填写 input / textarea / contenteditable。
- `personal_edge_navigate(url)`：让同一个共享标签页导航到新的 `http/https` URL。
- `personal_edge_reload()`：刷新共享标签页。

点击、输入、导航和刷新会进入 WebMCP 高影响审批体系；扩展仍不提供任意 JavaScript 执行。

扩展只和 `127.0.0.1:48321` 通信，不会把浏览器数据发送到额外的远程服务。

## 当前限制

- 只能控制用户主动共享的单个普通 `http/https` 标签页；
- 不控制 `edge://`、扩展商店等浏览器特权页面；
- 不提供任意桌面 GUI 控制、下载管理、文件选择器自动化或任意 JS；
- `personal_edge_*` 和 gateway-managed `browser_*` 是不同的外部浏览器能力，不应混淆。
