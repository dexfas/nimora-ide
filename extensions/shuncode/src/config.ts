import * as vscode from "vscode";

export const API_KEY_SECRET = "shuncode.apiKey";

export interface ShunCodeModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export async function getShunCodeModelConfig(context: vscode.ExtensionContext): Promise<ShunCodeModelConfig> {
  const config = vscode.workspace.getConfiguration("shuncode");
  return {
    baseUrl: config.get<string>("model.baseUrl", "https://api.openai.com/v1").trim(),
    model: config.get<string>("model.name", "gpt-5.4").trim(),
    apiKey: await context.secrets.get(API_KEY_SECRET),
  };
}

export async function configureShunCodeModel(context: vscode.ExtensionContext): Promise<boolean> {
  const current = await getShunCodeModelConfig(context);
  const baseUrl = await vscode.window.showInputBox({
    title: "ShunCode Model · Base URL",
    prompt: "OpenAI Chat Completions-compatible base URL.",
    value: current.baseUrl,
    ignoreFocusOut: true,
  });
  if (baseUrl === undefined) return false;

  const model = await vscode.window.showInputBox({
    title: "ShunCode Model · Model",
    prompt: "Model identifier sent to the configured endpoint.",
    value: current.model,
    ignoreFocusOut: true,
  });
  if (model === undefined) return false;

  const apiKey = await vscode.window.showInputBox({
    title: "ShunCode Model · API Key",
    prompt: "Stored in SecretStorage. Leave blank to keep the existing key; enter CLEAR to delete it.",
    password: true,
    ignoreFocusOut: true,
  });
  if (apiKey === undefined) return false;

  const config = vscode.workspace.getConfiguration("shuncode");
  await Promise.all([
    config.update("model.baseUrl", baseUrl.trim(), vscode.ConfigurationTarget.Global),
    config.update("model.name", model.trim(), vscode.ConfigurationTarget.Global),
  ]);

  if (apiKey.trim().toUpperCase() === "CLEAR") {
    await context.secrets.delete(API_KEY_SECRET);
  } else if (apiKey.trim()) {
    await context.secrets.store(API_KEY_SECRET, apiKey.trim());
  }

  return true;
}

export async function setShunCodeApiKey(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "ShunCode API Key",
    password: true,
    ignoreFocusOut: true,
    prompt: "Stored securely in VS Code SecretStorage. Submit an empty value to clear it.",
  });
  if (value === undefined) return;
  if (value.trim()) await context.secrets.store(API_KEY_SECRET, value.trim());
  else await context.secrets.delete(API_KEY_SECRET);
  await vscode.window.showInformationMessage(value.trim() ? "ShunCode API key saved." : "ShunCode API key cleared.");
}

