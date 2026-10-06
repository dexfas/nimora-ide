import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { ApiWorkerConfiguration } from "./api-worker-candidate-source.js";

export interface NimoraApiProfile {
  profileId: string;
  revision: string;
  label: string;
  baseUrl: string;
  model: string;
  protocol: "chat-completions" | "openai-responses" | "anthropic-messages";
  enabled: boolean;
}
const KEY = "nimora.apiProfiles.v1";
function normalizeProfile(value: unknown): NimoraApiProfile {
  const p = value as NimoraApiProfile;
  if (!p || Object.getPrototypeOf(p) !== Object.prototype || Object.keys(p).some(k => !["profileId", "revision", "label", "baseUrl", "model", "protocol", "enabled"].includes(k))
    || !/^[a-zA-Z0-9-]{1,80}$/.test(p.profileId) || !/^[a-zA-Z0-9-]{1,80}$/.test(p.revision)
    || typeof p.label !== "string" || !p.label.trim() || p.label.length > 80
    || typeof p.model !== "string" || !p.model.trim() || p.model.length > 160
    || typeof p.enabled !== "boolean" || !["chat-completions", "openai-responses", "anthropic-messages"].includes(p.protocol)) throw new Error("API Profile 元数据无效。");
  const url = new URL(p.baseUrl);
  if (url.username || url.password || url.search || url.hash || url.protocol !== "https:") throw new Error("API 端点必须是无内嵌凭据的 HTTPS URL。");
  return { ...p, baseUrl: url.toString().replace(/\/$/, "") };
}
/** Public metadata is separated from revision-specific SecretStorage. Editing
 * never overwrites a key referenced by a frozen existing session. */
export class NimoraApiProfiles {
  constructor(private readonly context: vscode.ExtensionContext) {}
  list(): NimoraApiProfile[] {
    const raw = this.context.globalState.get<unknown[]>(KEY, []);
    if (!Array.isArray(raw) || raw.length > 8) throw new Error("API Profiles 配置超限。");
    const profiles = raw.map(normalizeProfile);
    if (new Set(profiles.map(p => p.profileId)).size !== profiles.length) throw new Error("API Profile 身份重复。");
    return profiles;
  }
  async configurations(workspaceRoot: string): Promise<ApiWorkerConfiguration[]> {
    const result: ApiWorkerConfiguration[] = [];
    for (const profile of this.list().filter(p => p.enabled)) {
      const apiKey = await this.context.secrets.get(`${KEY}.${profile.profileId}.${profile.revision}`);
      if (!apiKey?.trim()) continue;
      result.push({ provider: "nimora-api", profileId: profile.profileId, configurationRevision: profile.revision,
        model: profile.model, workspaceRoot, runtime: { baseUrl: profile.baseUrl, apiKey, protocol: profile.protocol, retries: 0 } });
    }
    return result;
  }
  async configure(): Promise<void> {
    const profiles = this.list();
    const picked = await vscode.window.showQuickPick([{ label: "+ 新增 API 配置", profileId: undefined }, ...profiles.map(p => ({ label: p.label, description: `${p.model} · ${p.enabled ? "启用" : "停用"}`, profileId: p.profileId }))], { title: "Nimora · API 配置" });
    if (!picked) return;
    const old = profiles.find(p => p.profileId === picked.profileId);
    if (old) {
      const action = await vscode.window.showQuickPick(["编辑", old.enabled ? "停用" : "启用"], { title: old.label });
      if (!action) return;
      if (action !== "编辑") { await this.context.globalState.update(KEY, profiles.map(p => p === old ? { ...p, enabled: !p.enabled } : p)); return; }
    }
    if (!old && profiles.length >= 8) throw new Error("最多支持 8 个 API 配置。");
    const label = await vscode.window.showInputBox({ title: "API 配置名称", value: old?.label, ignoreFocusOut: true });
    if (label === undefined) return;
    const baseUrl = await vscode.window.showInputBox({ title: "API HTTPS 端点", value: old?.baseUrl, ignoreFocusOut: true });
    if (baseUrl === undefined) return;
    const model = await vscode.window.showInputBox({ title: "模型 ID", value: old?.model, ignoreFocusOut: true });
    if (model === undefined) return;
    const protocol = await vscode.window.showQuickPick(["chat-completions", "openai-responses", "anthropic-messages"] as const, { title: "API 协议" });
    if (!protocol) return;
    const profile = normalizeProfile({ profileId: old?.profileId ?? randomUUID(), revision: randomUUID(), label: label.trim(), baseUrl: baseUrl.trim(), model: model.trim(), protocol, enabled: true });
    const secret = await vscode.window.showInputBox({ title: "API 密钥", password: true, ignoreFocusOut: true, prompt: old ? "留空沿用原密钥。密钥仅保存到 SecretStorage。" : "密钥仅保存到 SecretStorage。" });
    if (secret === undefined) return;
    const apiKey = secret.trim() || (old && await this.context.secrets.get(`${KEY}.${old.profileId}.${old.revision}`));
    if (!apiKey) throw new Error("API 配置缺少密钥，未保存。");
    await this.context.secrets.store(`${KEY}.${profile.profileId}.${profile.revision}`, apiKey);
    await this.context.globalState.update(KEY, [...profiles.filter(p => p.profileId !== profile.profileId), profile]);
    void vscode.window.showInformationMessage("API 配置已保存；已有 Worker 保持原配置，新分配使用新版本。");
  }
}
