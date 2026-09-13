const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vscode = require('vscode');

function envPort(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback;
}

const HOST = '127.0.0.1';
const PORT = envPort('SHUNCODE_WEBMCP_CONTROL_PORT', 48322);
const BUILTIN_BROWSER_TOOLS = [
  'open_browser_page', 'list_browser_pages', 'read_page', 'click_element',
  'type_in_page', 'navigate_page', 'hover_element', 'drag_element',
  'handle_dialog', 'run_playwright_code', 'screenshot_page',
];

const ARENA_AGENT_SCRIPT_PATH = path.join(__dirname, 'arena-agent-bridge.js');
const WEB_MCP_PAGE_CORE_SCRIPT_PATH = path.join(__dirname, 'webmcp-page-core.js');
const WEB_MCP_SITE_ADAPTERS_SCRIPT_PATH = path.join(__dirname, 'webmcp-site-adapters.js');
const ARENA_PANEL_ID = 'shuncode-agent-bridge-panel';
const ARENA_AGENT_SCRIPT_URL = 'http://127.0.0.1:48324/agent.js';
const CDP_HOST = '127.0.0.1';
const CDP_PORT = 48323;
const ARENA_POLL_MS = 2500;
const WEB_MCP_HOST = '127.0.0.1';
const WEB_MCP_PORT = envPort('SHUNCODE_WEBMCP_GATEWAY_PORT', 48321);
const WEB_MCP_HIGH_IMPACT = new Set([
  'apply_patch', 'run_command', 'send_command_input',
  'personal_edge_click', 'personal_edge_fill', 'personal_edge_navigate', 'personal_edge_reload',
]);
const WEB_MCP_NATIVE_BYPASS_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const WEB_MCP_PAGE_TOKEN = require('node:crypto').randomUUID();
const WEB_MCP_APPROVAL_MODE_KEY = 'shuncode.webMcp.approvalMode';
const webMcpSessionApprovals = new Set();
let webMcpApprovalMode = 'session';
let arenaInjectBusy = false;
let arenaInjectTimer = null;
let arenaAgentSource = null;
let lastArenaStatus = { cdp: false, targets: 0, arenaTargets: 0, injected: 0, error: null };
let lastArenaError = '';
let sharePromptCooldownUntil = 0;
const injectionAttemptedPages = new Set();
let webMcpProcess = null;
let webMcpStartPromise = null;
let webMcpStatusItem = null;
let webMcpApprovalItem = null;

function webMcpHost(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); }
  catch { return ''; }
}

function shouldBypassWebMcp(url) {
  const host = webMcpHost(url);
  return WEB_MCP_NATIVE_BYPASS_HOSTS.has(host);
}

function webMcpApprovalKey(payload) {
  const sessionId = String(payload?.page?.sessionId || '').trim();
  if (!sessionId) return '';
  return sessionId;
}

function normalizeWebMcpApprovalMode(mode) {
  return ['trusted', 'session', 'always'].includes(mode) ? mode : 'session';
}

function webMcpApprovalModeLabel(mode = webMcpApprovalMode) {
  if (mode === 'trusted') return '完全信任';
  if (mode === 'always') return '每次都批准';
  return '本页帮我批准';
}

function updateWebMcpApprovalStatus() {
  if (!webMcpApprovalItem) return;
  const icon = webMcpApprovalMode === 'trusted' ? '$(unlock)' : webMcpApprovalMode === 'always' ? '$(shield)' : '$(shield-check)';
  webMcpApprovalItem.text = `${icon} ${webMcpApprovalModeLabel()}`;
  webMcpApprovalItem.tooltip = [
    'Web MCP 审批模式（点击切换）',
    webMcpApprovalMode === 'trusted'
      ? '完全信任：WebMCP 高影响工具自动执行，不弹 WebMCP 确认。'
      : webMcpApprovalMode === 'always'
        ? '每次都批准：每一个高影响工具调用都询问。'
        : '本页帮我批准：当前标签页第一次高影响操作询问一次，之后本页自动放行。',
    '注意：ShunCode 原生安全确认不由此选项绕过。',
  ].join('\n');
}

async function chooseWebMcpApprovalMode(context) {
  const items = [
    {
      label: '$(unlock) 完全信任',
      description: '不再弹 WebMCP 高影响工具确认',
      detail: '适合完全信任当前 WebMCP 网页代理时。仍不会绕过 ShunCode 自己的原生安全弹窗。',
      mode: 'trusted',
    },
    {
      label: '$(shield-check) 本页帮我批准',
      description: '推荐',
      detail: '每个标签页第一次高影响操作问一次；批准后，该标签页后续高影响 WebMCP 操作（包括代码/命令和 Personal Edge 交互）自动放行。',
      mode: 'session',
    },
    {
      label: '$(shield) 每次都批准',
      description: '最谨慎',
      detail: '每一个高影响工具调用都弹确认。',
      mode: 'always',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Web MCP 审批模式',
    placeHolder: `当前：${webMcpApprovalModeLabel()}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  webMcpApprovalMode = normalizeWebMcpApprovalMode(picked.mode);
  webMcpSessionApprovals.clear();
  await context.globalState.update(WEB_MCP_APPROVAL_MODE_KEY, webMcpApprovalMode);
  updateWebMcpApprovalStatus();
  vscode.window.showInformationMessage(`Web MCP 审批模式已切换为：${webMcpApprovalModeLabel()}`);
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map(part => {
    if (part instanceof vscode.LanguageModelTextPart) return part.value;
    if (part && typeof part.value === 'string') return part.value;
    return '';
  }).join('\n');
}

function playwrightResultValue(result, label = 'WebMCP page control') {
  const text = resultText(result);
  const line = text.split(/\r?\n/).find(value => value.startsWith('Result: '));
  if (!line) throw new Error(`${label} did not return a structured result: ${text.slice(0, 1200) || 'empty result'}`);
  try {
    return JSON.parse(line.slice('Result: '.length));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function httpGetJson(host, port, requestPath, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: requestPath }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${host}:${port}${requestPath}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout connecting to ${host}:${port}`)));
    req.on('error', reject);
  });
}

function getArenaAgentSource() {
  if (arenaAgentSource === null) {
    const agentSource = fs.readFileSync(ARENA_AGENT_SCRIPT_PATH, 'utf8').trim();
    const coreSource = fs.readFileSync(WEB_MCP_PAGE_CORE_SCRIPT_PATH, 'utf8').trim();
    const siteAdaptersSource = fs.readFileSync(WEB_MCP_SITE_ADAPTERS_SCRIPT_PATH, 'utf8').trim();
    arenaAgentSource = `(function shunCodeWebMcpComposedAgent(config) {\n`
      + `  const createCore = (${coreSource});\n`
      + `  const createSiteAdapter = (${siteAdaptersSource});\n`
      + `  const agent = (${agentSource});\n`
      + `  return agent(config, { createCore, createSiteAdapter });\n`
      + `})`;
  }
  return arenaAgentSource;
}

function cdpEvaluate(webSocketDebuggerUrl, expression, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const WebSocketCtor = globalThis.WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      reject(new Error('WebSocket is unavailable in the extension host'));
      return;
    }
    let settled = false;
    const ws = new WebSocketCtor(webSocketDebuggerUrl);
    const timer = setTimeout(() => finish(new Error('CDP Runtime.evaluate timed out')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      error ? reject(error) : resolve(value);
    };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    ws.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error) return finish(new Error(message.error.message || 'CDP error'));
        if (message.result?.exceptionDetails) {
          const detail = message.result.exceptionDetails.exception?.description
            || message.result.exceptionDetails.text
            || 'Arena injection evaluation failed';
          return finish(new Error(detail));
        }
        finish(null, message.result?.result?.value);
      } catch (error) {
        finish(error);
      }
    });
    ws.addEventListener('error', () => finish(new Error('CDP WebSocket connection failed')));
  });
}

function isWorkbenchTarget(target) {
  return target?.type === 'page'
    && typeof target.url === 'string'
    && target.url.startsWith('vscode-file://vscode-app/')
    && target.url.includes('/workbench/workbench.html');
}

async function inspectAndShareArenaInWorkbench() {
  const targets = await httpGetJson(CDP_HOST, CDP_PORT, '/json/list');
  const workbench = Array.isArray(targets) ? targets.find(isWorkbenchTarget) : null;
  if (!workbench?.webSocketDebuggerUrl) {
    throw new Error('ShunCode workbench CDP target not found');
  }
  const mayClickShare = Date.now() >= sharePromptCooldownUntil;
  const expression = `(() => {
    const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const isArena = value => {
      try {
        const url = new URL(String(value || '').trim());
        return url.protocol === 'https:' && (url.hostname === 'arena.ai' || url.hostname.endsWith('.arena.ai'));
      } catch { return false; }
    };
    let arenaRoots = 0;
    let sharedArenaRoots = 0;
    let shareClicked = false;
    const urls = [];
    for (const root of document.querySelectorAll('.browser-root')) {
      if (!visible(root)) continue;
      const url = root.querySelector('.browser-url-display')?.textContent?.trim() || '';
      if (!isArena(url)) continue;
      arenaRoots += 1;
      urls.push(url);
      const container = root.querySelector('.browser-container');
      if (container?.classList.contains('shared')) {
        sharedArenaRoots += 1;
        continue;
      }
      if (${mayClickShare ? 'true' : 'false'}) {
        const button = root.querySelector('.browser-share-toggle');
        if (visible(button)) {
          button.click();
          shareClicked = true;
          break;
        }
      }
    }
    return { arenaRoots, sharedArenaRoots, shareClicked, urls };
  })()`;
  const state = await cdpEvaluate(workbench.webSocketDebuggerUrl, expression);
  if (state?.shareClicked) {
    sharePromptCooldownUntil = Date.now() + 30000;
  }
  return { targets: Array.isArray(targets) ? targets.length : 0, ...(state || {}) };
}

async function listSharedArenaPages() {
  const cts = new vscode.CancellationTokenSource();
  try {
    const result = await vscode.lm.invokeTool('list_browser_pages', {
      toolInvocationToken: undefined,
      input: {},
    }, cts.token);
    const text = resultText(result);
    const pages = [];
    for (const line of text.split(/\r?\n/)) {
      if (!/https:\/\/(?:[^\s/]+\.)?arena\.ai(?:[\s/):]|$)/i.test(line)) continue;
      const match = line.match(/\[([0-9a-f-]{36})\]/i);
      if (match) pages.push({ pageId: match[1], line });
    }
    return pages;
  } finally {
    cts.dispose();
  }
}

async function injectSharedArenaPage(pageId, output) {
  if (injectionAttemptedPages.has(pageId)) return false;
  injectionAttemptedPages.add(pageId);
  const cts = new vscode.CancellationTokenSource();
  try {
    const code = `
      const exists = await page.locator('#${ARENA_PANEL_ID}').count();
      if (exists) return { alreadyPresent: true };
      const source = await page.evaluate(async () => await (await fetch('${ARENA_AGENT_SCRIPT_URL}')).text());
      await page.evaluate(source);
      return { injected: true };
    `;
    output.appendLine(`[arena] Shared Arena page ${pageId} found; requesting one-time Playwright injection approval.`);
    const result = await vscode.lm.invokeTool('run_playwright_code', {
      toolInvocationToken: undefined,
      input: { pageId, code, timeoutMs: 10000 },
    }, cts.token);
    const text = resultText(result);
    const ok = /injected.*true|alreadyPresent.*true/i.test(text);
    if (!ok) injectionAttemptedPages.delete(pageId);
    return ok;
  } catch (error) {
    injectionAttemptedPages.delete(pageId);
    throw error;
  } finally {
    cts.dispose();
  }
}

function scheduleArenaInjection(output, delayMs) {
  if (arenaInjectTimer) clearTimeout(arenaInjectTimer);
  arenaInjectTimer = setTimeout(() => {
    arenaInjectTimer = null;
    void ensureArenaInjected(output);
  }, delayMs);
}

async function ensureArenaInjected(output) {
  if (arenaInjectBusy) return;
  arenaInjectBusy = true;
  try {
    const workbenchState = await inspectAndShareArenaInWorkbench();
    if (workbenchState.shareClicked) {
      output.appendLine('[arena] Arena detected; triggered ShunCode Share with Agent. Approve the ShunCode share dialog if it appears.');
    }
    const sharedPages = workbenchState.arenaRoots > 0 ? await listSharedArenaPages() : [];
    let injected = 0;
    for (const { pageId } of sharedPages) {
      if (await injectSharedArenaPage(pageId, output)) {
        injected += 1;
        output.appendLine(`[arena] MCP bridge ready on Arena page ${pageId}.`);
      }
    }
    lastArenaStatus = {
      cdp: true,
      targets: workbenchState.targets,
      arenaTargets: workbenchState.arenaRoots || 0,
      sharedArenaTargets: sharedPages.length,
      shareClicked: !!workbenchState.shareClicked,
      injected,
      error: null,
    };
    lastArenaError = '';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastArenaStatus = { cdp: false, targets: 0, arenaTargets: 0, injected: 0, error: message };
    if (message !== lastArenaError) {
      output.appendLine(`[arena] CDP watcher waiting: ${message}`);
      lastArenaError = message;
    }
  } finally {
    arenaInjectBusy = false;
    scheduleArenaInjection(output, ARENA_POLL_MS);
  }
}

function webMcpRequest(method, requestPath, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: WEB_MCP_HOST,
      port: WEB_MCP_PORT,
      path: requestPath,
      method,
      headers: payload ? {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      } : {},
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; }
        catch { return reject(new Error(`Invalid Web MCP response: ${text.slice(0, 400)}`)); }
        if ((res.statusCode || 500) >= 400 || parsed?.ok === false) {
          return reject(new Error(parsed?.error || `Web MCP HTTP ${res.statusCode}`));
        }
        resolve(parsed);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Web MCP request timed out: ${requestPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function findGatewayDirectory() {
  const folders = vscode.workspace.workspaceFolders || [];
  const candidates = [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    candidates.push(
      path.join(root, 'ShunCode-Browser-MCP', 'ShunCode-Browser-MCP'),
      path.join(root, 'ShunCode-Browser-MCP'),
      root,
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'server.mjs'))) return candidate;
  }
  const found = await vscode.workspace.findFiles(
    '**/ShunCode-Browser-MCP/ShunCode-Browser-MCP/server.mjs',
    '**/{node_modules,browser-profile}/**',
    1,
  );
  return found[0] ? path.dirname(found[0].fsPath) : null;
}

function updateWebMcpStatus(text, tooltip) {
  if (!webMcpStatusItem) return;
  webMcpStatusItem.text = text;
  webMcpStatusItem.tooltip = tooltip;
}

async function gatewayIsReady() {
  try {
    return await webMcpRequest('GET', '/control/healthz', undefined, 800);
  } catch {
    return null;
  }
}

async function ensureWebMcpGateway(output) {
  const ready = await gatewayIsReady();
  if (ready?.integratedWebMcp) return ready;
  if (ready) {
    throw new Error(`端口 ${WEB_MCP_PORT} 正在运行旧版 Web MCP 网关。请先停止旧网关，再重新点击 MCP。`);
  }
  if (webMcpStartPromise) return await webMcpStartPromise;

  webMcpStartPromise = (async () => {
    const recheck = await gatewayIsReady();
    if (recheck?.integratedWebMcp) return recheck;
    if (recheck) throw new Error('端口 48321 正在运行旧版 Web MCP 网关。请先停止旧网关，再重新点击 MCP。');

    const gatewayDir = await findGatewayDirectory();
    if (!gatewayDir) throw new Error('找不到 ShunCode-Browser-MCP/server.mjs。请先打开包含该项目的 ShunCode 工作区。');

    if (!webMcpProcess || webMcpProcess.exitCode !== null) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      env.PORT = String(WEB_MCP_PORT);
      env.SHUNCODE_INTEGRATED_BROWSER_BRIDGE = `http://${HOST}:${PORT}`;
      env.SHUNCODE_WEBMCP_PAGE_CORE_PATH = WEB_MCP_PAGE_CORE_SCRIPT_PATH;
      env.SHUNCODE_WEBMCP_SITE_ADAPTERS_PATH = WEB_MCP_SITE_ADAPTERS_SCRIPT_PATH;
      env.SHUNCODE_WEBMCP_PAGE_AGENT_PATH = ARENA_AGENT_SCRIPT_PATH;
      webMcpProcess = spawn('node', ['server.mjs'], {
        cwd: gatewayDir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      webMcpProcess.stdout?.on('data', chunk => output.append(`[web-mcp] ${String(chunk)}`));
      webMcpProcess.stderr?.on('data', chunk => output.append(`[web-mcp:error] ${String(chunk)}`));
      webMcpProcess.on('exit', code => {
        output.appendLine(`[web-mcp] gateway exited with code ${code}`);
        webMcpProcess = null;
        updateWebMcpStatus('$(plug) Web MCP', '在当前 ShunCode 内置浏览器页面启用/停用 Web MCP');
      });
    }

    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const state = await gatewayIsReady();
      if (state?.integratedWebMcp) return state;
      if (state) throw new Error('端口 48321 被不兼容的旧版 Web MCP 网关占用。');
      if (webMcpProcess?.exitCode !== null && webMcpProcess?.exitCode !== undefined) break;
    }
    throw new Error('Web MCP 网关启动失败。请查看 Integrated Browser Bridge 输出日志。');
  })();

  try {
    return await webMcpStartPromise;
  } finally {
    webMcpStartPromise = null;
  }
}

function summarizeWebMcpTool(tool) {
  const schema = tool?.inputSchema || {};
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const args = Object.entries(properties).map(([name, value]) => {
    const type = Array.isArray(value?.type) ? value.type.join('|') : (value?.type || 'any');
    return `${name}:${type}${required.has(name) ? '*' : ''}`;
  }).join(', ');
  const description = String(tool?.description || tool?.modelDescription || '')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  return `- ${tool.name}(${args})${description ? ` — ${description}` : ''}`;
}

function spawnCapture(command, args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on('data', chunk => stdout.push(chunk));
    child.stderr?.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${(err || out).slice(0, 800)}`));
    });
  });
}

function parseClipboardToolCall(text) {
  const source = String(text || '');
  const patterns = [
    /\[SHUNCODE_TOOL\]\s*([\s\S]*?)\s*\[\/SHUNCODE_TOOL\]/,
    /```SHUNCODE_TOOL\s*([\s\S]*?)```/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const call = JSON.parse(match[1].trim());
    if (!call || typeof call.name !== 'string') throw new Error('剪贴板里的 SHUNCODE_TOOL 格式无效。');
    return call;
  }
  return null;
}

function webMcpResultText(result) {
  if (result == null) return 'null';
  if (Array.isArray(result.content)) {
    const text = result.content.map(part => part?.text ?? part?.value ?? '').filter(Boolean).join('\n');
    if (text) return text.slice(0, 12000);
  }
  try { return JSON.stringify(result, null, 2).slice(0, 12000); }
  catch { return String(result).slice(0, 12000); }
}

async function safeClipboardWebMcpStep(output) {
  updateWebMcpStatus('$(shield) Web MCP Safe', '安全模式：不控制 BrowserView，不启动 Playwright');
  try {
    const clipboard = await vscode.env.clipboard.readText();
    let call;
    try { call = parseClipboardToolCall(clipboard); }
    catch (error) { throw new Error(`无法解析工具请求：${error instanceof Error ? error.message : String(error)}`); }

    if (!call) {
      await ensureWebMcpGateway(output);
      const response = await webMcpRequest('GET', '/control/shuncode-tools?protocol=2', undefined, 10000);
      const tools = Array.isArray(response.tools) ? response.tools : [];
      const toolList = tools.map(summarizeWebMcpTool).join('\n');
      const prompt = `You can use ShunCode MCP tools through this chat.\n\nAvailable tools (* = required argument):\n${toolList}\n\nWhen a tool is required, reply with exactly ONE request and no other text:\n[SHUNCODE_TOOL]\n{"id":"unique-call-id","name":"TOOL_NAME","arguments":{}}\n[/SHUNCODE_TOOL]\n\nDo not use Markdown fences around the request. Wait for a [SHUNCODE_TOOL_RESULT] message before continuing. Never invent tool results. Prefer read/search/diagnostic tools before edits or commands. Keep working until the user's task is complete.`;
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.showInformationMessage(`Web MCP 安全模式：提示词已复制（${tools.length} 个工具）。请粘贴到当前 AI 聊天区。`);
      return;
    }

    if (WEB_MCP_HIGH_IMPACT.has(call.name)) {
      const choice = await vscode.window.showWarningMessage(
        `Web MCP 请求执行高影响工具：${call.name}`,
        { modal: true, detail: JSON.stringify(call.arguments || {}, null, 2).slice(0, 3000) },
        '允许执行',
      );
      if (choice !== '允许执行') {
        const denied = `[SHUNCODE_TOOL_RESULT]\n${JSON.stringify({ id: call.id || null, name: call.name, ok: false, error: 'User denied this tool call' }, null, 2)}\n[/SHUNCODE_TOOL_RESULT]`;
        await vscode.env.clipboard.writeText(denied);
        vscode.window.showInformationMessage('已拒绝工具调用；拒绝结果已复制，可粘贴回 AI。');
        return;
      }
    }

    const result = await invokeIntegratedWebMcpTool(output, call);
    const payload = { id: call.id || null, name: call.name, ok: true, result: webMcpResultText(result) };
    const resultMessage = `[SHUNCODE_TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, request exactly one tool and wait for its result.`;
    await vscode.env.clipboard.writeText(resultMessage);
    vscode.window.showInformationMessage(`Web MCP：${call.name} 已执行，真实结果已复制。请粘贴回 AI。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp:safe] ${message}`);
    vscode.window.showErrorMessage(`Web MCP 安全模式：${message}`);
  } finally {
    updateWebMcpStatus('$(shield) Web MCP Safe', '安全模式：复制提示词或执行剪贴板中的 SHUNCODE_TOOL');
  }
}

async function invokeBuiltinBrowserTool(name, input = {}) {
  const found = vscode.lm.tools.find(tool => tool.name === name);
  if (!found) throw new Error(`ShunCode built-in browser tool is not registered: ${name}`);
  const cts = new vscode.CancellationTokenSource();
  try {
    return await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input }, cts.token);
  } finally {
    cts.dispose();
  }
}

function parseSharedBrowserPages(text) {
  const pages = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/- \[([0-9a-f-]{36})\]\s+(.+?)\s+\((https?:\/\/[^)]+)\)(.*)$/i);
    if (!match) continue;
    pages.push({ pageId: match[1], title: match[2], url: match[3], visible: !/not visible/i.test(match[4] || '') });
  }
  return pages;
}

async function getOrShareCurrentBrowserPage(output) {
  const listed = await invokeBuiltinBrowserTool('list_browser_pages', {});
  let pages = parseSharedBrowserPages(resultText(listed));
  if (pages.length) return pages.find(page => page.visible) || pages.at(-1);

  output.appendLine('[web-mcp] No shared Integrated Browser page; waiting for the native Share with Agent button.');
  updateWebMcpStatus('$(share-window) Web MCP', '请点内置浏览器地址栏旁的“分享给 Agent”图标；共享后会自动继续');
  vscode.window.showInformationMessage('Web MCP 正在等待当前网页共享。请点击内置浏览器地址栏旁的“分享给 Agent”图标；共享成功后会自动继续连接。');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 600));
    const relisted = await invokeBuiltinBrowserTool('list_browser_pages', {});
    pages = parseSharedBrowserPages(resultText(relisted));
    if (pages.length) {
      const page = pages.find(item => item.visible) || pages.at(-1);
      output.appendLine(`[web-mcp] Native browser share detected: ${page.pageId} ${page.url}`);
      return page;
    }
  }

  updateWebMcpStatus('$(plug) Web MCP', '连接当前内置浏览器聊天页');
  throw new Error('等待网页共享超时。请先点击内置浏览器地址栏旁的“分享给 Agent”图标，再点击 Web MCP。');
}

async function connectCurrentWebMcpPage(output) {
  updateWebMcpStatus('$(sync~spin) Web MCP', '正在连接当前内置浏览器聊天页…');
  try {
    await ensureWebMcpGateway(output);
    const page = await getOrShareCurrentBrowserPage(output);
    if (shouldBypassWebMcp(page.url)) {
      try {
        await invokeBuiltinBrowserTool('run_playwright_code', {
          pageId: page.pageId,
          code: `return await page.evaluate(() => { try { window.__shuncodeWebMcp?.stop?.(); } catch {} return { stopped: true, url: location.href }; });`,
          timeoutMs: 6000,
        });
      } catch {}
      const host = webMcpHost(page.url) || page.url || page.title || page.pageId;
      updateWebMcpStatus('$(circle-slash) Web MCP', `已跳过：${host}`);
      output.appendLine(`[web-mcp] bypassed native-MCP page: ${page.url || ''}`);
      vscode.window.showInformationMessage(`Web MCP 已跳过 ${host}。按你的设置，此页面使用原生 MCP/工具能力，不注入 WebMCP。`);
      return;
    }
    const source = getArenaAgentSource();
    const expression = `(${source})(${JSON.stringify({ bridge: `http://${HOST}:${PORT}`, token: WEB_MCP_PAGE_TOKEN })})`;
    const code = `
      const expression = ${JSON.stringify(expression)};
      const status = await page.evaluate(source => (0, eval)(source), expression);
      const prime = await page.evaluate(async () => await window.__shuncodeWebMcp.prime());
      return { status, prime, url: page.url() };
    `;
    const injected = await invokeBuiltinBrowserTool('run_playwright_code', { pageId: page.pageId, code, timeoutMs: 20000 });
    const text = resultText(injected);
    if (!/toolCount|alreadyPrimed|version[^\d]*25/i.test(text)) {
      throw new Error(`网页 Web MCP 注入未确认成功：${text.slice(0, 1200) || '无返回结果'}`);
    }
    const tools = await webMcpRequest('GET', '/control/shuncode-tools?protocol=2', undefined, 10000);
    const toolCount = Array.isArray(tools.tools) ? tools.tools.length : 0;
    updateWebMcpStatus('$(check) Web MCP', `已连接：${page.url || page.title || page.pageId}`);
    output.appendLine(`[web-mcp] connected page=${page.pageId} url=${page.url || ''} tools=${toolCount}`);
    vscode.window.showInformationMessage(`Web MCP 已连接当前网页，${toolCount} 个真实 ShunCode 工具可用。后续工具请求会自动往返。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp:connect] ${message}`);
    updateWebMcpStatus('$(error) Web MCP', '连接失败，点击重试');
    vscode.window.showErrorMessage(`Web MCP：${message}`);
  }
}

async function connectWebMcpWorkerPage(output, options = {}) {
  await ensureWebMcpGateway(output);
  const page = await getOrShareCurrentBrowserPage(output);
  if (shouldBypassWebMcp(page.url)) {
    throw new Error(`Web worker transport cannot attach to a native-MCP bypass page: ${page.url || page.title || page.pageId}`);
  }
  const source = getArenaAgentSource();
  const expression = `(${source})(${JSON.stringify({ bridge: `http://${HOST}:${PORT}`, token: WEB_MCP_PAGE_TOKEN })})`;
  const shouldPrime = options?.prime !== false;
  const code = `
    const expression = ${JSON.stringify(expression)};
    const status = await page.evaluate(source => (0, eval)(source), expression);
    const prime = ${shouldPrime ? 'await page.evaluate(async () => await window.__shuncodeWebMcp.prime())' : 'null'};
    const workerSession = await page.evaluate(() => window.__shuncodeWebMcp.workerSession());
    return { status, prime, workerSession, url: page.url() };
  `;
  const result = await invokeBuiltinBrowserTool('run_playwright_code', { pageId: page.pageId, code, timeoutMs: 20000 });
  const connected = playwrightResultValue(result, 'WebMCP worker connect');
  if (connected?.status?.version !== 25 || !connected?.workerSession?.sessionId) {
    throw new Error(`WebMCP worker connection did not expose the v25 worker contract: ${JSON.stringify(connected).slice(0, 1200)}`);
  }
  output.appendLine(`[web-mcp:worker] connected page=${page.pageId} session=${connected.workerSession.sessionId} site=${connected.workerSession.site || connected.status.siteAdapter || ''}`);
  return {
    pageId: page.pageId,
    ...connected.workerSession,
    status: connected.status,
    prime: connected.prime,
  };
}

async function controlWebMcpWorkerPage(request) {
  const pageId = String(request?.pageId || '').trim();
  const sessionId = String(request?.sessionId || '').trim();
  const action = String(request?.action || '').trim();
  if (!pageId || !sessionId || !action) throw new Error('WebMCP worker control requires pageId, sessionId and action.');
  const payload = {
    sessionId,
    action,
    input: request?.input,
    inputId: request?.inputId,
    result: request?.result,
  };
  const code = `
    const request = ${JSON.stringify(payload)};
    return await page.evaluate(async request => {
      const api = window.__shuncodeWebMcp;
      if (!api || api.version !== 25 || typeof api.workerSession !== 'function') throw new Error('WebMCP v25 worker contract is unavailable on this page');
      const session = api.workerSession();
      if (session.sessionId !== request.sessionId) throw new Error('WebMCP worker page session changed; reconnect the worker session');
      if (request.action === 'send') return await api.workerSend(request.input);
      if (request.action === 'poll') return api.workerPoll(request.inputId);
      if (request.action === 'interrupt') return { interrupted: await api.workerInterrupt(request.inputId), turn: api.workerPoll(request.inputId) };
      if (request.action === 'resolve') return await api.workerResolveCapability(request.result);
      if (request.action === 'health') return { session, status: api.status() };
      if (request.action === 'disconnect') {
        const status = api.status();
        if (status.workerTurn?.state === 'running') await api.workerInterrupt(status.workerTurn.inputId);
        return { disconnected: true, session };
      }
      throw new Error('Unsupported WebMCP worker action: ' + request.action);
    }, request);
  `;
  const result = await invokeBuiltinBrowserTool('run_playwright_code', {
    pageId,
    code,
    timeoutMs: action === 'send' ? 20000 : 10000,
  });
  return playwrightResultValue(result, `WebMCP worker ${action}`);
}

async function stopCurrentWebMcpPage(output) {
  try {
    const listed = await invokeBuiltinBrowserTool('list_browser_pages', {});
    const pages = parseSharedBrowserPages(resultText(listed));
    const page = pages.find(item => item.visible) || pages.at(-1);
    if (page) {
      const code = `
        const stopped = await page.evaluate(() => {
          if (!window.__shuncodeWebMcp) return false;
          window.__shuncodeWebMcp.stop();
          return true;
        });
        return { stopped, url: page.url() };
      `;
      await invokeBuiltinBrowserTool('run_playwright_code', { pageId: page.pageId, code, timeoutMs: 10000 });
    }
    updateWebMcpStatus('$(plug) Web MCP', '连接当前内置浏览器聊天页');
    vscode.window.showInformationMessage(page ? '当前网页的 Web MCP 已停止。' : '当前没有已共享的 Web MCP 网页。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp:stop] ${message}`);
    vscode.window.showErrorMessage(`停止 Web MCP 失败：${message}`);
  }
}

async function getIntegratedWebMcpPrompt(output, options) {
  if (Number(options?.protocolVersion) !== 2) {
    throw new Error('检测到旧版高负载 Web MCP Workbench 补丁，已阻止启动。请先升级到 V2 轻量观察器补丁。');
  }
  await ensureWebMcpGateway(output);
  const response = await webMcpRequest('GET', '/control/shuncode-tools?protocol=2', undefined, 10000);
  const tools = Array.isArray(response.tools) ? response.tools : [];
  const toolList = tools.map(summarizeWebMcpTool).join('\n');
  const prompt = `You can use ShunCode MCP tools through this chat.\n\nAvailable tools (* = required argument):\n${toolList}\n\nWhen a tool is required, reply with exactly ONE request and no other text:\n[SHUNCODE_TOOL]\n{"id":"unique-call-id","name":"TOOL_NAME","arguments":{}}\n[/SHUNCODE_TOOL]\n\nDo not use Markdown fences around the request. Wait for a [SHUNCODE_TOOL_RESULT] message before continuing. Never invent tool results. Prefer read/search/diagnostic tools before edits or commands. Keep working until the user's task is complete.`;
  return { prompt, toolCount: tools.length };
}

async function invokeIntegratedWebMcpTool(output, request) {
  await ensureWebMcpGateway(output);
  const name = String(request?.name || '').trim();
  if (!name) throw new Error('缺少 MCP 工具名称');
  const args = request?.arguments && typeof request.arguments === 'object' ? request.arguments : {};
  const response = await webMcpRequest('POST', '/control/invoke-shuncode?protocol=2', { name, arguments: args }, 120000);
  return response.result;
}

async function toggleIntegratedWebMcp(output) {
  try {
    await ensureWebMcpGateway(output);
    await vscode.commands.executeCommand('workbench.action.browser.toggleWebMcp');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp] ${message}`);
    vscode.window.showErrorMessage(`Web MCP：${message}`);
  }
}

async function startOrConnectWebMcp(output) {
  updateWebMcpStatus('$(sync~spin) Web MCP', '正在启动/连接网页 MCP…');
  try {
    await ensureWebMcpGateway(output);
    await webMcpRequest('POST', '/control/start-browser', {} , 20000);
    const result = await webMcpRequest('POST', '/control/connect-current', { prime: true }, 30000);
    const url = result?.page?.url || '';
    const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

    if (!/^https?:/i.test(url)) {
      updateWebMcpStatus('$(browser) Web MCP', '专用浏览器已启动；打开 AI 聊天页后再次点击连接');
      vscode.window.showInformationMessage('Web MCP 浏览器已启动。请在这个专用 Edge 里打开任意 AI 聊天网站，然后再点一次底部 “Web MCP” 按钮。');
      return;
    }
    if (!result.chatDetected) {
      updateWebMcpStatus('$(browser) Web MCP', `${host || '当前网页'}：等待聊天输入框`);
      vscode.window.showInformationMessage(`已挂载 ${host || url}，但暂时没有识别到聊天输入框。进入具体对话页面后再点一次 “Web MCP”。`);
      return;
    }

    const toolCount = result?.primeResult?.toolCount;
    updateWebMcpStatus('$(check) Web MCP', `${host || '当前聊天页'} 已连接`);
    vscode.window.showInformationMessage(
      `Web MCP 已连接 ${host || url}${Number.isInteger(toolCount) ? `，${toolCount} 个工具可用` : ''}。后续工具调用会自动在聊天区往返。`,
    );
  } catch (error) {
    updateWebMcpStatus('$(error) Web MCP', 'Web MCP 启动/连接失败');
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp] ${message}`);
    vscode.window.showErrorMessage(`Web MCP：${message}`);
  }
}

async function stopWebMcpBrowser(output) {
  try {
    const ready = await gatewayIsReady();
    if (ready) await webMcpRequest('POST', '/control/stop-browser', {}, 15000);
    updateWebMcpStatus('$(plug) Web MCP', '启动/连接通用网页 MCP');
    vscode.window.showInformationMessage('Web MCP 专用浏览器已停止。');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[web-mcp] stop failed: ${message}`);
    vscode.window.showErrorMessage(`停止 Web MCP 失败：${message}`);
  }
}

async function showWebMcpStatus() {
  const ready = await gatewayIsReady();
  if (!ready) {
    vscode.window.showInformationMessage('Web MCP 网关当前未运行。');
    return;
  }
  vscode.window.showInformationMessage('Web MCP 网关已运行。请使用底部状态栏的 “Web MCP” 连接当前内置浏览器聊天页。');
}

function webMcpCorsHeaders(req) {
  const origin = String(req.headers.origin || '');
  const allowOrigin = /^https?:\/\//i.test(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-ShunCode-WebMcp-Token',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  };
}

function sendJson(req, res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...webMcpCorsHeaders(req),
  });
  res.end(text);
}

function assertWebMcpPageToken(req) {
  if (String(req.headers['x-shuncode-webmcp-token'] || '') !== WEB_MCP_PAGE_TOKEN) {
    throw new Error('Invalid Web MCP page token');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function encodePart(part) {
  if (part instanceof vscode.LanguageModelTextPart) return { type: 'text', text: part.value };
  if (part && typeof part === 'object' && part.value instanceof Uint8Array) {
    return { type: 'data', base64: Buffer.from(part.value).toString('base64') };
  }
  if (part && typeof part === 'object' && typeof part.value === 'string') return { type: 'text', text: part.value };
  return { type: 'unknown', value: String(part) };
}

async function invoke(name, input) {
  if (!BUILTIN_BROWSER_TOOLS.includes(name)) throw new Error(`unsupported browser tool: ${name}`);
  const found = vscode.lm.tools.find(tool => tool.name === name);
  if (!found) throw new Error(`ShunCode built-in browser tool is not registered: ${name}`);
  const cts = new vscode.CancellationTokenSource();
  try {
    const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input: input || {} }, cts.token);
    return { name, content: result.content.map(encodePart) };
  } finally {
    cts.dispose();
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Integrated Browser Bridge');
  context.subscriptions.push(output);

  webMcpApprovalMode = normalizeWebMcpApprovalMode(context.globalState.get(WEB_MCP_APPROVAL_MODE_KEY, 'session'));

  webMcpStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  webMcpStatusItem.command = 'shuncode.webMcp.connect';
  webMcpStatusItem.text = '$(plug) Web MCP';
  webMcpStatusItem.tooltip = '连接当前内置浏览器聊天页；首次连接只做一次注入，不持续运行 Playwright';
  webMcpStatusItem.show();
  context.subscriptions.push(webMcpStatusItem);

  webMcpApprovalItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  webMcpApprovalItem.command = 'shuncode.webMcp.approvalMode';
  webMcpApprovalItem.show();
  updateWebMcpApprovalStatus();
  context.subscriptions.push(webMcpApprovalItem);
  context.subscriptions.push(
    vscode.commands.registerCommand('shuncode.webMcp.connect', () => connectCurrentWebMcpPage(output)),
    vscode.commands.registerCommand('shuncode.webMcp.clipboard', () => safeClipboardWebMcpStep(output)),
    vscode.commands.registerCommand('shuncode.webMcp.stop', () => stopCurrentWebMcpPage(output)),
    vscode.commands.registerCommand('shuncode.webMcp.status', () => showWebMcpStatus()),
    vscode.commands.registerCommand('shuncode.webMcp.approvalMode', () => chooseWebMcpApprovalMode(context)),
    vscode.commands.registerCommand('_shuncode.webMcp.getPrompt', options => getIntegratedWebMcpPrompt(output, options)),
    vscode.commands.registerCommand('_shuncode.webMcp.invoke', request => invokeIntegratedWebMcpTool(output, request)),
    vscode.commands.registerCommand('_shuncode.webMcp.workerConnect', options => connectWebMcpWorkerPage(output, options)),
    vscode.commands.registerCommand('_shuncode.webMcp.workerSend', request => controlWebMcpWorkerPage({ ...request, action: 'send' })),
    vscode.commands.registerCommand('_shuncode.webMcp.workerPoll', request => controlWebMcpWorkerPage({ ...request, action: 'poll' })),
    vscode.commands.registerCommand('_shuncode.webMcp.workerInterrupt', request => controlWebMcpWorkerPage({ ...request, action: 'interrupt' })),
    vscode.commands.registerCommand('_shuncode.webMcp.workerResolve', request => controlWebMcpWorkerPage({ ...request, action: 'resolve' })),
    vscode.commands.registerCommand('_shuncode.webMcp.workerHealth', request => controlWebMcpWorkerPage({ ...request, action: 'health' })),
    vscode.commands.registerCommand('_shuncode.webMcp.workerDisconnect', request => controlWebMcpWorkerPage({ ...request, action: 'disconnect' })),
  );
  updateWebMcpStatus('$(plug) Web MCP', '连接当前内置浏览器聊天页');

  context.subscriptions.push({
    dispose: () => {
      if (arenaInjectTimer) clearTimeout(arenaInjectTimer);
      arenaInjectTimer = null;
      if (webMcpProcess && webMcpProcess.exitCode === null) {
        try { webMcpProcess.kill(); } catch {}
      }
      webMcpProcess = null;
      webMcpStartPromise = null;
      webMcpApprovalItem = null;
    },
  });
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, webMcpCorsHeaders(req));
        return res.end();
      }
      if (req.method === 'GET' && req.url === '/agent.js') {
        const source = getArenaAgentSource();
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': Buffer.byteLength(source),
          ...webMcpCorsHeaders(req),
        });
        return res.end(source);
      }
      if (req.method === 'GET' && req.url === '/webmcp/tools') {
        assertWebMcpPageToken(req);
        await ensureWebMcpGateway(output);
        const response = await webMcpRequest('GET', '/control/shuncode-tools?protocol=2', undefined, 10000);
        return sendJson(req, res, 200, { ok: true, tools: Array.isArray(response.tools) ? response.tools : [] });
      }
      if (req.method === 'POST' && req.url === '/webmcp/invoke') {
        assertWebMcpPageToken(req);
        const payload = await readBody(req);
        const name = String(payload.name || '').trim();
        if (!name) throw new Error('Missing Web MCP tool name');
        if (WEB_MCP_HIGH_IMPACT.has(name)) {
          const approvalKey = webMcpApprovalKey(payload);
          const alreadyApprovedForPage = approvalKey && webMcpSessionApprovals.has(approvalKey);
          const shouldPrompt = webMcpApprovalMode === 'always' || (webMcpApprovalMode === 'session' && !alreadyApprovedForPage);
          if (shouldPrompt) {
            const sourceHost = webMcpHost(payload?.page?.href) || String(payload?.page?.origin || '').replace(/^https?:\/\//, '') || '当前网页';
            const buttons = webMcpApprovalMode === 'session' ? ['批准并信任本页'] : ['允许一次'];
            const choice = await vscode.window.showWarningMessage(
              `网页请求执行 ShunCode 工具：${name}`,
              { modal: true, detail: `${sourceHost}\n\n${JSON.stringify(payload.arguments || {}, null, 2).slice(0, 3000)}` },
              ...buttons,
            );
            if (choice === '批准并信任本页' && approvalKey) webMcpSessionApprovals.add(approvalKey);
            if (choice !== '允许一次' && choice !== '批准并信任本页') {
              return sendJson(req, res, 403, { ok: false, error: 'User denied this tool call' });
            }
          }
        }
        const result = await invokeIntegratedWebMcpTool(output, { name, arguments: payload.arguments || {} });
        return sendJson(req, res, 200, { ok: true, result });
      }
      if (req.method === 'GET' && req.url === '/healthz') {
        const registered = new Set(vscode.lm.tools.map(tool => tool.name));
        return sendJson(req, res, 200, {
          ok: true,
          available: BUILTIN_BROWSER_TOOLS.filter(name => registered.has(name)),
          missing: BUILTIN_BROWSER_TOOLS.filter(name => !registered.has(name)),
        });
      }
      if (req.method === 'GET' && req.url === '/tools') {
        const registered = new Map(vscode.lm.tools.map(tool => [tool.name, tool]));
        return sendJson(req, res, 200, {
          tools: BUILTIN_BROWSER_TOOLS.map(name => registered.get(name)).filter(Boolean).map(tool => ({
            name: tool.name,
            description: tool.description || tool.modelDescription || tool.name,
            inputSchema: tool.inputSchema || { type: 'object' },
          })),
        });
      }
      if (req.method === 'POST' && req.url === '/invoke') {
        const payload = await readBody(req);
        const result = await invoke(String(payload.name || ''), payload.input || {});
        return sendJson(req, res, 200, { ok: true, result });
      }
      return sendJson(req, res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[error] ${message}`);
      return sendJson(req, res, 500, { ok: false, error: message });
    }
  });
  server.listen(PORT, HOST, () => output.appendLine(`Listening on http://${HOST}:${PORT}`));
  server.on('error', error => output.appendLine(`[server] ${error.message}`));
  context.subscriptions.push({ dispose: () => server.close() });
}

module.exports = { activate, deactivate() {} };
