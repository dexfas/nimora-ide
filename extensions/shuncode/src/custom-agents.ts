import * as vscode from "vscode";

export function registerShunCodeCustomAgents(context: vscode.ExtensionContext): vscode.Disposable {
  const askUri = vscode.Uri.joinPath(context.extensionUri, "agents", "shuncode-ask.agent.md");
  const planUri = vscode.Uri.joinPath(context.extensionUri, "agents", "shuncode-plan.agent.md");
  const codeUri = vscode.Uri.joinPath(context.extensionUri, "agents", "shuncode-code.agent.md");

  return vscode.chat.registerCustomAgentProvider({
    provideCustomAgents: () => [
      { uri: askUri },
      { uri: planUri },
      { uri: codeUri },
    ],
  });
}
