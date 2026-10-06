import { createHash } from "node:crypto";
import { buildProjectFormationReceipt } from "../../../src/project-contract.js";
import { normalizeWorkerAssignmentRequest } from "../../../src/worker-assignment.js";
import { missionEntryCapabilityMaterialization } from "../../../src/mission-user-entry-application.js";

/** Human-supplied evidence, NOT a new provider turn or proof of the old session. */
export interface ReviewedWebCognition {
  json: string;
  digest: string;
  projectTitle: string;
  projectGoal: string;
  firstMissionGoal: string;
  instruction: string;
}

const EXACT_FIELDS = ["classification", "project", "initialRoot", "coordinatorPolicy", "workerPolicy", "instruction", "requiredCapabilityIds"];
const REVIEWED_READ_CAPS = new Set(["workspace.list-directory", "workspace.read-files"]);

export function validateReviewedWebCognition(raw: string, workspace: string): ReviewedWebCognition {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 65_536) throw new Error("人工审核的 Cognition JSON 内容为空或超过上限。");
  if (typeof workspace !== "string" || !workspace.trim()) throw new Error("必须绑定真实的本地工作区。");
  const row: unknown = JSON.parse(raw);
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("恢复结果必须是一个 JSON 对象。");
  const result = row as Record<string, unknown>;
  if (Object.keys(result).length !== EXACT_FIELDS.length || Object.keys(result).some(key => !EXACT_FIELDS.includes(key))) {
    throw new Error("审核结果的七项字段必须与 Formation Cognition 协议完全一致。");
  }
  if (result.classification !== "requires-human-confirmation") throw new Error("人工恢复仅接入明确要求再次人工确认的旧 Cognition 结果。");
  const project = result.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("Project seed 无效。");
  const projectData = project as Record<string, unknown>;
  if (projectData.workspace !== undefined && projectData.workspace !== workspace) throw new Error("旧结果要求的工作区与当前工作区不一致。");
  const initialRoot = result.initialRoot;
  if (!initialRoot || typeof initialRoot !== "object" || Array.isArray(initialRoot)
    || (initialRoot as Record<string, unknown>).plane !== "cognition") throw new Error("此恢复流程只允许已有的只读 Cognition 首个 Mission。");
  const capabilityIds = result.requiredCapabilityIds;
  if (!Array.isArray(capabilityIds) || !capabilityIds.length || capabilityIds.some(id => typeof id !== "string" || !REVIEWED_READ_CAPS.has(id))) {
    throw new Error("恢复旧结果的首个 Mission 只能请求列目录和读文件能力。");
  }
  missionEntryCapabilityMaterialization(capabilityIds);
  const validatedPolicies: Record<string, unknown> = {};
  for (const name of ["coordinatorPolicy", "workerPolicy"] as const) {
    const candidate = result[name];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`缺少 ${name}。`);
    const policy = candidate as Record<string, unknown>;
    if (Object.keys(policy).some(key => key !== "constraints" && key !== "preferences")) throw new Error(`${name} 含未知字段。`);
    const normalized = normalizeWorkerAssignmentRequest({ projectId: "reviewed", rootMissionId: "reviewed", missionId: "reviewed", ...policy });
    const constraints = normalized.constraints ?? {};
    if ((constraints.allowedKinds && !constraints.allowedKinds.includes("web"))
      || (constraints.allowedProviders && !constraints.allowedProviders.includes("deepseek"))
      || constraints.forbiddenProviders?.includes("deepseek")
      || (name === "coordinatorPolicy" && constraints.requiredCapabilities?.capabilityRequests === false)) {
      throw new Error(`${name} 与用户选择的 DeepSeek 网页 Worker 冲突。`);
    }
    validatedPolicies[name] = {
      constraints: { ...constraints, allowedKinds: ["web"], allowedProviders: ["deepseek"] },
      preferences: { ...(normalized.preferences ?? {}), providerOrder: ["deepseek"] },
    };
  }
  buildProjectFormationReceipt({
    formationId: "human-reviewed-result-preflight",
    project: { ...projectData, workspace }, initialRoot,
    authorization: { kind: "human-confirmed" },
  });
  if (typeof result.instruction !== "string" || !result.instruction.trim() || result.instruction.length > 30_000) {
    throw new Error("旧结果没有可用的首个 Mission 指令。");
  }
  const admitted = { ...result, ...validatedPolicies };
  const json = JSON.stringify(admitted);
  return {
    json,
    digest: createHash("sha256").update(raw).digest("hex"),
    projectTitle: typeof projectData.title === "string" ? projectData.title : "未命名 Project",
    projectGoal: String(projectData.goal),
    firstMissionGoal: String((initialRoot as Record<string, unknown>).goal),
    instruction: result.instruction,
  };
}
