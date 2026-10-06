import * as vscode from "vscode";
import { missionSkillObservationFromPlatformAgentSkill, type MissionSkillSourceAdapter, type MissionSkillObservation } from "../../../src/mission-skill-index.js";

/** Uses the platform's existing discovery owner for workspace, user, extension
 * and plugin Skills. Discovery confers no Nimora trust or tool authorization. */
export function createPlatformSkillSource(): MissionSkillSourceAdapter {
  const observed = new Map<string, MissionSkillObservation>();
  const read = async () => {
    const cancellation = new vscode.CancellationTokenSource();
    try {
      if (typeof vscode.chat.getSkills !== "function") return [];
      const skills = await vscode.chat.getSkills(cancellation.token);
      if (skills.length > 256) throw new Error("Platform Skill discovery exceeds the bounded index limit.");
      return skills.map(skill => missionSkillObservationFromPlatformAgentSkill({
        uri: skill.uri.toString(), storage: skill.source, name: skill.name, description: skill.description,
        enabled: skill.enabled === true, disableModelInvocation: skill.disableModelInvocation ?? true, userInvocable: skill.userInvocable ?? true,
        sessionTypes: skill.sessionTypes ? [...skill.sessionTypes] : undefined,
        extensionId: skill.extensionId, pluginUri: skill.pluginUri?.toString(),
      }));
    } finally { cancellation.dispose(); }
  };
  return {
    adapterId: "nimora.platform-skills",
    listSkills: async () => {
      const rows = await read(); observed.clear();
      for (const row of rows) observed.set(row.skillId, row);
      return rows;
    },
    loadContent: async target => {
      const prior = observed.get(target.skillId);
      const fresh = (await read()).find(row => row.skillId === target.skillId);
      if (!prior || !fresh || !fresh.enabled || fresh.sourceId !== target.sourceId
        || fresh.canonicalLocator !== target.canonicalLocator || JSON.stringify(fresh) !== JSON.stringify(prior)) {
        throw new Error("Platform Skill provenance or enablement changed before content load.");
      }
      const uri = vscode.Uri.parse(fresh.canonicalLocator);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > 64_000) throw new Error("Platform Skill must be a bounded regular file.");
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > 64_000) throw new Error("Platform Skill content exceeds the bounded limit.");
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    },
  };
}
