# ShunCode Browser MCP Gateway

This gateway keeps the tools from an existing ShunCode Bridge MCP endpoint and adds persistent browser automation.

Added tools: `browser_open`, `browser_pages`, `browser_click`, `browser_fill`, `browser_get_text`, `browser_dom`, `browser_evaluate`, and `browser_screenshot`.

The browser uses a dedicated persistent Microsoft Edge profile under `browser-profile/`, so login state can survive MCP calls and restarts.

Set the upstream ShunCode Bridge endpoint through `SHUNCODE_MCP_URL`, then run with `npm start`:

```powershell
$env:SHUNCODE_MCP_URL = "https://your-bridge.example/mcp/<route-token>"
npm start
```

The local MCP endpoint is `http://127.0.0.1:48321/mcp`. Do not commit the real upstream URL or route token.

## Generic Web MCP chat mode

The gateway also exposes local control endpoints used by the ShunCode extension-side **Web MCP** button:

- `POST /control/start-browser` starts the persistent Edge browser.
- `POST /control/connect-current` attaches the currently visible page to ShunCode MCP and optionally primes its chat composer.
- `GET /control/status` reports browser pages.
- `POST /control/stop-browser` closes the managed browser.

`generic-chat-agent.js` contains the site-agnostic adapter. It detects common `textarea`/`contenteditable` chat composers, sends the MCP activation prompt, watches the rendered conversation for `[SHUNCODE_TOOL]...[/SHUNCODE_TOOL]`, executes the requested MCP tool through a page-scoped Playwright binding, and returns `[SHUNCODE_TOOL_RESULT]` to the same chat.

Each attached page gets a random token and unique binding names. File edits and command execution require an explicit browser confirmation before the request is forwarded.
