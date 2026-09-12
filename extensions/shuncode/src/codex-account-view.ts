import * as vscode from "vscode";
import { codexAuthManager, onCodexAuthChange, type CodexAuthStatus } from "./codex-auth.js";

interface ViewState extends CodexAuthStatus {
  busy: boolean;
  busyLabel?: string;
}

/**
 * "Codex Account" settings sub-page rendered in the ShunCode activity-bar view container.
 * Shows the sign-in state as a card, offers Sign in / Sign out actions, and keeps the
 * rendered state in sync with the shared ~/.codex/auth.json credentials.
 */
export class CodexAccountViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "shuncode.codexView";

  private view: vscode.WebviewView | undefined;
  private busy = false;
  private busyLabel: string | undefined;

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    void this.pushState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    const type = message && typeof message === "object" ? (message as { type?: unknown }).type : undefined;
    switch (type) {
      case "ready":
        await this.pushState();
        return;
      case "signin":
        await this.signIn();
        return;
      case "signout":
        await this.signOut();
        return;
      case "openConfig":
        await vscode.commands.executeCommand("shuncode.configureModel");
        return;
    }
  }

  private async signIn(): Promise<void> {
    if (this.busy) return;
    const current = await codexAuthManager.getStatus();
    if (current.signedIn) {
      this.notify("info", "Already signed in. Sign out first to switch accounts.");
      return;
    }
    this.busy = true;
    this.busyLabel = "Waiting for browser authorization…";
    await this.pushState();
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Codex sign-in: complete the authorization in your browser…",
          cancellable: true,
        },
        async (_progress, token) => {
          await codexAuthManager.startLogin(token);
        },
      );
      // onCodexAuthChange fires with the persisted credentials; the card refreshes itself.
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        this.notify("info", "Codex sign-in was cancelled.");
      } else {
        this.notify("error", `Codex sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.busy = false;
      this.busyLabel = undefined;
      await this.pushState();
    }
  }

  private async signOut(): Promise<void> {
    if (this.busy) return;
    const current = await codexAuthManager.getStatus();
    if (!current.signedIn) return;
    const choice = await vscode.window.showWarningMessage(
      `Sign out of Codex as ${current.account?.email ?? current.account?.accountId}? This also signs out the official Codex CLI.`,
      { modal: true },
      "Sign Out",
    );
    if (choice !== "Sign Out") return;
    this.busy = true;
    this.busyLabel = "Signing out…";
    await this.pushState();
    try {
      await codexAuthManager.signOut();
    } catch (error) {
      this.notify("error", `Failed to sign out of Codex: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      this.busyLabel = undefined;
      await this.pushState();
    }
  }

  private async pushState(): Promise<void> {
    const status = await codexAuthManager.getStatus();
    const state: ViewState = { ...status, busy: this.busy, busyLabel: this.busyLabel };
    void this.view?.webview.postMessage({ type: "state", state });
  }

  private notify(kind: "info" | "error", text: string): void {
    void this.view?.webview.postMessage({ type: "message", kind, text });
  }

  /** Push fresh state whenever the shared credentials change (login, refresh, logout). */
  readonly onAuthChange: vscode.Disposable = onCodexAuthChange(() => {
    void this.pushState();
  });

  dispose(): void {
    this.onAuthChange.dispose();
    this.view = undefined;
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = `shuncode-${Math.random().toString(36).slice(2)}`;
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      "img-src data:",
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    color-scheme: var(--vscode-color-scheme, light dark);
  }
  body {
    margin: 0;
    padding: 14px 16px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: transparent;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .header .logo {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    background: linear-gradient(135deg, #10a37f, #0e7a5f);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
  }
  .header .title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    opacity: 0.9;
  }
  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 14px;
    margin-bottom: 12px;
  }
  .card h3 {
    margin: 0 0 8px 0;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    opacity: 0.75;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 6px 0;
    word-break: break-all;
  }
  .row .key {
    min-width: 84px;
    opacity: 0.6;
    font-size: 11px;
  }
  .row .value {
    font-size: 12px;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
  }
  .badge.ok {
    color: var(--vscode-testing-iconPassed, #89d185);
    border: 1px solid var(--vscode-testing-iconPassed, #89d185);
  }
  .badge.off {
    color: var(--vscode-testing-iconFailed, #f14c4c);
    border: 1px solid var(--vscode-testing-iconFailed, #f14c4c);
  }
  .badge.busy {
    color: var(--vscode-charts-yellow, #cca700);
    border: 1px solid var(--vscode-charts-yellow, #cca700);
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    font-size: 12px;
    font-family: var(--vscode-font-family);
    cursor: pointer;
  }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  button.primary:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .hint {
    font-size: 11px;
    opacity: 0.75;
    line-height: 1.5;
    margin: 0 0 4px 0;
  }
  .hint code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--vscode-charts-yellow, #cca700);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: -2px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hidden { display: none !important; }
  .message {
    font-size: 11px;
    margin: 8px 0 0 0;
    padding: 6px 8px;
    border-radius: 4px;
  }
  .message.error { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
  .message.info { background: var(--vscode-inputValidation-infoBackground); color: var(--vscode-inputValidation-infoForeground); }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <div class="header">
    <div class="logo">C</div>
    <div class="title">Codex Account</div>
  </div>

  <!-- Signed in -->
  <div id="signedIn" class="card hidden">
    <h3>Signed in</h3>
    <div class="row"><span class="key">Account</span><span class="value" id="accountEmail"></span></div>
    <div class="row"><span class="key">Account ID</span><span class="value" id="accountId"></span></div>
    <div class="row"><span class="key">Plan</span><span class="value" id="accountPlan"></span></div>
    <div class="row"><span class="key">Token</span><span class="value" id="tokenExpiry"></span></div>
    <div class="row"><span class="badge ok" id="statusBadge">Active</span></div>
    <div class="actions">
      <button class="secondary" id="btnSignOut">Sign out</button>
    </div>
  </div>

  <!-- Signed out -->
  <div id="signedOut" class="card hidden">
    <h3>Not signed in</h3>
    <p class="hint">Sign in with your ChatGPT subscription to use Codex models directly in Chat.</p>
    <div class="actions">
      <button class="primary" id="btnSignIn">Sign in with Codex</button>
    </div>
    <p class="hint" style="margin-top:10px">Uses the same OAuth credentials as the official Codex CLI
      (<code>~/.codex/auth.json</code>), so an existing <code>codex login</code> is reused automatically.</p>
  </div>

  <!-- Busy -->
  <div id="busy" class="card hidden">
    <div class="row"><span class="spinner"></span><span class="value" id="busyLabel">Working…</span></div>
    <p class="hint" id="busyHint"></p>
  </div>

  <div class="card">
    <h3>How to use Codex models</h3>
    <p class="hint">1. Sign in above.</p>
    <p class="hint">2. Open <a href="#" id="linkConfig">ShunCode: Configure Model</a> and set <b>Authentication</b> to <code>Codex</code>.</p>
    <p class="hint">3. Pick a Codex model in the Chat model picker — streaming, reasoning and tool calls work exactly like custom API models.</p>
  </div>

  <div id="messageBox" class="message hidden"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let lastState = null;

  function render(state) {
    lastState = state;
    $("signedIn").classList.toggle("hidden", !(state.signedIn && !state.busy));
    $("signedOut").classList.toggle("hidden", !(!state.signedIn && !state.busy));
    $("busy").classList.toggle("hidden", !state.busy);

    if (state.signedIn) {
      const account = state.account || {};
      $("accountEmail").textContent = account.email || account.accountId || "Unknown";
      $("accountId").textContent = account.accountId || "-";
      $("accountPlan").textContent = account.planType || "Unknown";
      $("tokenExpiry").textContent = state.expiresAt
        ? new Date(state.expiresAt * 1000).toLocaleString()
        : "Unknown";
    }
    if (state.busy) {
      $("busyLabel").textContent = state.busyLabel || "Working…";
      $("busyHint").textContent = state.busyLabel === "Waiting for browser authorization…"
        ? "A browser window should open. Complete the sign-in there; this page updates automatically."
        : "";
    }
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message) return;
    if (message.type === "state") { hideMessage(); render(message.state); }
    if (message.type === "message") { showMessage(message.kind, message.text); }
  });

  function showMessage(kind, text) {
    const box = $("messageBox");
    box.className = "message " + kind;
    box.textContent = text;
    box.classList.remove("hidden");
  }
  function hideMessage() { $("messageBox").classList.add("hidden"); }

  $("btnSignIn").addEventListener("click", () => { hideMessage(); post("signin"); });
  $("btnSignOut").addEventListener("click", () => post("signout"));
  $("linkConfig").addEventListener("click", (e) => { e.preventDefault(); post("openConfig"); });

  function post(type) { vscode.postMessage({ type }); }

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}
