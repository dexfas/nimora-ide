import type { MissionSkillLoadTarget, MissionSkillObservation, MissionSkillSourceAdapter } from "../../../src/mission-skill-index.js";

interface BuiltInSkill { observation: MissionSkillObservation; content: string; }
const SOURCE_VERSION = "phase13-v1";
const BUILT_INS: readonly BuiltInSkill[] = Object.freeze([
  {
    observation: {
      sourceId: "nimora:first-party:cognition-evidence-review:v1", sourceKind: "builtin",
      canonicalLocator: "nimora://builtin-skills/cognition-evidence-review-v1", skillId: "nimora.cognition-evidence-review-v1",
      name: "Nimora Cognition Evidence Review", title: "Cognition evidence review discipline",
      description: "Keep Cognition decisions grounded in canonical Evidence, Problems and completion criteria.",
      storage: "builtin", enabled: true, disableModelInvocation: false, userInvocable: false, sourceVersion: SOURCE_VERSION,
      eligibleMissionPlanes: ["cognition"],
    },
    content: [
      "Use canonical Project/Mission facts, Evidence, Problems, Answers and committed decisions as the basis for judgment.",
      "Provider prose, UI progress and Worker self-reports are not execution truth unless host-derived records support them.",
      "Issue only bounded Work Orders with explicit completion criteria and capability needs.",
      "When current criteria are satisfied, stop creating work and propose completion instead of manufacturing activity.",
    ].join("\n"),
  },
  {
    observation: {
      sourceId: "nimora:first-party:practice-verify-before-report:v1", sourceKind: "builtin",
      canonicalLocator: "nimora://builtin-skills/practice-verify-before-report-v1", skillId: "nimora.practice-verify-before-report-v1",
      name: "Nimora Practice Verify Before Report", title: "Practice reality and verification discipline",
      description: "Make bounded changes, validate them and report reality without inventing evidence.",
      storage: "builtin", enabled: true, disableModelInvocation: false, userInvocable: false, sourceVersion: SOURCE_VERSION,
      eligibleMissionPlanes: ["practice"],
    },
    content: [
      "Inspect the relevant workspace state before changing it and stay inside the authorized Mission scope.",
      "Prefer bounded changes and independently validate the result with available host capabilities.",
      "Report Result, Evidence and Problem from observed reality; never claim an execution, file state or test outcome that was not observed.",
      "If evidence is insufficient or a capability fails, surface the precise Problem instead of guessing or silently retrying side effects.",
    ].join("\n"),
  },
  {
    observation: {
      sourceId: "nimora:first-party:coordination-transport-discipline:v1", sourceKind: "builtin",
      canonicalLocator: "nimora://builtin-skills/coordination-transport-discipline-v1", skillId: "nimora.coordination-transport-discipline-v1",
      name: "Nimora Coordination Transport Discipline", title: "Coordinator exact transport discipline",
      description: "Keep Coordinator mechanical, exact and non-semantic.",
      storage: "builtin", enabled: true, disableModelInvocation: false, userInvocable: false, sourceVersion: SOURCE_VERSION,
      eligibleMissionPlanes: ["coordination"],
    },
    content: [
      "Transport and execute only the exact semantic command already authorized by the owning Cognition or Human governance path.",
      "Do not create goals, reinterpret completion, invent retries or become a second Cognition brain.",
      "Preserve Project, Mission, Worker, input and occurrence identities across transport and settlement.",
      "If delivery or execution is UNKNOWN, fail closed and preserve the uncertainty; never convert ambiguity into retry authority.",
    ].join("\n"),
  },
]);

export function createNimoraFirstPartySkillSource(): MissionSkillSourceAdapter {
  const byId = new Map(BUILT_INS.map(entry => [entry.observation.skillId, entry] as const));
  return {
    adapterId: "nimora-first-party-builtins",
    firstPartyBuiltInAuthority: true,
    async listSkills(): Promise<readonly MissionSkillObservation[]> {
      return BUILT_INS.map(entry => structuredClone(entry.observation));
    },
    async loadContent(target: MissionSkillLoadTarget): Promise<{ content: string; sourceVersion: string }> {
      const entry = byId.get(target.skillId);
      if (!entry || entry.observation.sourceId !== target.sourceId || entry.observation.canonicalLocator !== target.canonicalLocator) {
        throw new Error("Unknown or mismatched Nimora first-party Skill target: " + target.skillId);
      }
      return { content: entry.content, sourceVersion: SOURCE_VERSION };
    },
  };
}
