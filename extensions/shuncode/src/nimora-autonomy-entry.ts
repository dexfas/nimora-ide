import * as vscode from "vscode";
import { requireActiveProjectRoot } from "../../../src/project-active-root.js";
import type { WorkerConversationBudget } from "../../../src/worker-conversation-lifecycle.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";
import { inspectUnboundDeepSeekPages, prepareExactFreshDeepSeekWorkers } from "./nimora-reviewed-worker-takeover.js";
import { autonomyStartClaims, type NimoraAutonomyStartConsent } from "./nimora-autonomy-start-consent.js";
import { randomUUID } from "node:crypto";
import { normalizeResourcePolicy, readResourcePolicy, resourceAssignment, RESOURCE_POLICY_PREFIX } from "../../../src/mission-resource-policy.js";
import { resourcePreferences, resourceConsentText } from "./nimora-resource-settings.js";

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;
const NATIVE_OPEN_SHARE = "workbench.action.browser.nimoraOpenAndShareProviderPage";
const AUTONOMY_OUTCOME_KEY = "nimora.autonomyOutcome.v1";

export interface NimoraAutonomyCommandRequest {
  projectId?: string;
  /** Test/diagnostic override only; ordinary product calls use conservative defaults. */
  lifecycleBudget?: Partial<WorkerConversationBudget>;
  maxRounds?: number;
  /** An unapproved resource draft. Only the native modal may authorize it. */
  resources?: unknown;
}

/** Product seam for one explicitly-started bounded autonomy run.
 * No timers/background job are installed. Each new web page still requires the
 * native Human share action and every capability keeps its existing approval gate. */
export function registerNimoraAutonomyEntry(
  context: vscode.ExtensionContext,
  composition: Composition,
  workersReady: Promise<unknown>,
  startConsent?: NimoraAutonomyStartConsent,
): vscode.Disposable {
  const pageHost = {
    listResources: () => Promise.resolve(vscode.commands.executeCommand("_shuncode.webMcp.workerListResources")),
    openAndShareNewPage: async () => {
      const result = await vscode.commands.executeCommand<unknown>(NATIVE_OPEN_SHARE, "deepseek", true);
      return result && typeof result === "object" && "shared" in result && "pageId" in result
        ? result as { shared: true; pageId: string }
        : undefined;
    },
    wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  };

  const ensureFreshUnboundPages = async (count: number): Promise<readonly { pageId: string; candidateId: string }[]> => {
    if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("Autonomy page request must be between 1 and 8.");
    let available = [...await inspectUnboundDeepSeekPages(composition.webCandidates, pageHost)]
      .sort((a, b) => a.pageId.localeCompare(b.pageId));
    let preparations = 0;
    while (available.length < count) {
      if (++preparations > Math.ceil(count / 3) + 1) throw new Error("网页准备未收敛；停止开页，请核实登录和共享状态。");
      const batch = Math.min(3, count - available.length) as 1 | 2 | 3;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: "Nimora · 为自主 Mission 准备独立 DeepSeek Worker",
        cancellable: false,
      }, progress => prepareExactFreshDeepSeekWorkers(
        composition.webCandidates,
        pageHost,
        message => progress.report({ message }),
        { count: batch },
      ));
      available = [...await inspectUnboundDeepSeekPages(composition.webCandidates, pageHost)]
        .sort((a, b) => a.pageId.localeCompare(b.pageId));
    }
    return available.slice(0, count);
  };

  return vscode.commands.registerCommand("shuncode.nimora.runWebAutonomy", async (request?: NimoraAutonomyCommandRequest) => {
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== "file") {
      throw new Error("请在当前可信的单文件夹本地工作区中运行 Nimora 自主工作。");
    }
    await workersReady;
    await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
    const webProjectIds = new Set(context.workspaceState.get<string[]>("nimora.webProjectIds", []));
    const eligibleProjects = composition.owners.projects.listProjects().filter(project =>
      webProjectIds.has(project.projectId) && project.workspace === folders[0].uri.fsPath);
    let projectId = request?.projectId?.trim();
    if (projectId) {
      if (!eligibleProjects.some(project => project.projectId === projectId)) {
        throw new Error("所选项目不属于当前工作区，或尚未登记为受 Nimora 管理的自治项目。");
      }
    } else if (eligibleProjects.length === 1) {
      projectId = eligibleProjects[0].projectId;
    } else if (eligibleProjects.length > 1) {
      const picked = await vscode.window.showQuickPick(eligibleProjects.map(project => ({
        label: project.title?.trim() || project.goal?.trim() || project.projectId,
        description: project.projectId,
        detail: project.goal?.trim(),
        projectId: project.projectId,
      })), { title: "选择要继续自主工作的 Nimora 项目", placeHolder: "只显示当前工作区中受 Nimora 管理的自治项目" });
      if (!picked) return { state: "cancelled" };
      projectId = picked.projectId;
    } else {
      throw new Error("当前工作区没有可继续的 Nimora 自治项目。");
    }
    const project = composition.owners.projects.getProject(projectId);
    const missions = composition.owners.tasks.listTasks().filter(task => task.mission?.projectId === projectId);
    const root = requireActiveProjectRoot(missions, projectId);
    if (!project || project.workspace !== folders[0].uri.fsPath) {
      throw new Error("自主运行需要当前工作区中唯一、活动的 Cognition root。");
    }
    if (missions.some(task => Object.values(task.executions).some(execution =>
      execution.status === "unknown" || execution.status === "executing" || execution.status === "requested"
      || execution.deliveryStatus === "unknown" || execution.deliveryStatus === "pending"))) {
      throw new Error("项目仍有待核实、运行中或未确认投递的执行；先核实原事实，Nimora 不会自动重播。");
    }
    const inspection = await composition.coordinator.inspectManagedScope({
      projectId, managedRootMissionId: root.taskId,
    });
    const scope = {
      projectId,
      rootMissionId: root.taskId,
      coordinationMissionId: inspection.coordinationMissionId,
    };
    const existingResourcePolicy = readResourcePolicy(root);
    if (existingResourcePolicy && request?.resources !== undefined) throw new Error("当前 root 已有持久资源授权；新偏好只在后续轮次重新确认。");
    const resourcePolicy = existingResourcePolicy ?? (request?.resources === undefined ? resourcePreferences(context)
      : normalizeResourcePolicy({ ...(request.resources as Record<string, unknown>), revision: randomUUID() }));
    const resourceBoundaryText = resourcePolicy.mode === "api"
      ? "本轮只使用已授权的 API 资源；付费范围仍受本轮资源授权约束。"
      : resourcePolicy.mode === "mixed"
        ? "需要网页 AI 时会逐页请求原生共享授权；API 资源只在本轮授权范围内使用。"
        : "需要新网页时会逐页请求原生共享授权。";
    let alreadyApproved = false;
    if (startConsent) {
      const fresh = await Promise.all(missions.filter(task => task.mission?.rootMissionId === root.taskId)
        .map(task => composition.owners.tasks.rereadTask(task.taskId)));
      if (fresh.some(task => !task)) throw new Error("本轮启动授权真值无法完整读取。");
      alreadyApproved = startConsent.consume(autonomyStartClaims(folders[0].uri.fsPath, project,
        root.taskId, inspection.coordinationMissionId, fresh as import("../../../src/task-contract.js").TaskSnapshot[]), request);
    }
    const approved = alreadyApproved ? "启动有界自主协作" : await vscode.window.showInformationMessage("启动 Nimora 有界自主协作？", {
      modal: true,
      detail: resourceConsentText(resourcePolicy) + " 负责规划的文会读取当前任务、问题和证据，最多连续运行 8 轮。" + resourceBoundaryText + " 文件、终端等能力仍走原权限门。任何待核实执行、服务回执不明或轮次上限都会立即停止；不会创建后台任务或重放旧输入。",
    }, "启动有界自主协作", "取消");
    if (approved !== "启动有界自主协作") return { state: "cancelled" };
    if (!readResourcePolicy(root)) {
      await composition.owners.tasks.replaceMissionConstraintsStrict(root.taskId, root.context.constraints,
        [...root.context.constraints, RESOURCE_POLICY_PREFIX + JSON.stringify(resourcePolicy)]);
    }
    const assertResourceScope = async (): Promise<void> => {
      const fresh = await composition.owners.tasks.rereadTask(root.taskId);
      if (!fresh || fresh.missionFinalization || JSON.stringify(readResourcePolicy(fresh)) !== JSON.stringify(resourcePolicy)) throw new Error("本轮资源授权已变化；没有新分配或发送。");
    };
    const assignmentFor = async (missionId: string) => {
      await assertResourceScope();
      const task = await composition.owners.tasks.rereadTask(missionId);
      if (!task?.mission || task.mission.projectId !== projectId || task.mission.rootMissionId !== root.taskId) throw new Error("资源分配目标不属于本轮。");
      return resourceAssignment(resourcePolicy, { projectId, rootMissionId: root.taskId }, missionId, task.mission.plane);
    };

    const ensureAssigned = async (missionIds: readonly string[]): Promise<void> => {
      const frontier = await composition.parallelReadiness.inspect({
        projectId, rootMissionId: root.taskId, missionIds,
      });
      const needed = frontier.missions.filter(mission => mission.state === "ready-unassigned");
      if (!needed.length) return;
      if (resourcePolicy.mode !== "web") {
        for (const mission of needed) {
          const assignment = await assignmentFor(mission.missionId);
          let outcome = await composition.plannedWork.assignReady({ projectId, rootMissionId: root.taskId, requests: [assignment] });
          if (outcome.outcomes[0]?.state === "no-admissible-candidate" && resourcePolicy.mode === "mixed") {
            const [page] = await ensureFreshUnboundPages(1);
            await assertResourceScope();
            outcome = await composition.plannedWork.assignReady({ projectId, rootMissionId: root.taskId, requests: [assignment], exactCandidateIds: { [mission.missionId]: page.candidateId } });
          }
          if (outcome.outcomes[0]?.state !== "assigned") throw new Error(`Mission ${mission.missionId} 未分配：${outcome.outcomes[0]?.state}；没有自动重试或跨越资源授权。`);
        }
        return;
      }
      const pages = await ensureFreshUnboundPages(needed.length);
      const result = await composition.plannedWork.assignReady({
        projectId, rootMissionId: root.taskId,
        requests: needed.map(mission => ({
          ...resourceAssignment(resourcePolicy, { projectId, rootMissionId: root.taskId }, mission.missionId, "practice"),
        })),
        exactCandidateIds: Object.fromEntries(needed.map((mission, index) => [mission.missionId, pages[index].candidateId])),
      });
      const failed = result.outcomes.filter(row => row.state !== "assigned");
      if (failed.length) throw new Error("至少一个 ready Mission 未能绑定确切新 Worker；没有向任何未绑定 Mission 发送 Work Order。");
    };

    const ensureConversation = async (missionId: string): Promise<void> => {
      await assertResourceScope();
      const observed = await composition.succession.inspect({
        projectId, rootMissionId: root.taskId, missionId,
      }, request?.lifecycleBudget);
      if (observed.capacity.state === "normal" || observed.capacity.state === "unknown") return;
      if (observed.capacity.state === "approaching-limit") {
        await composition.succession.reconcile({
          projectId, rootMissionId: root.taskId, missionId, budget: request?.lifecycleBudget,
        });
        return;
      }
      if (!observed.knownSettled) {
        throw new Error(`Mission ${missionId} 已需接班，但旧 Worker 存在未收敛 Provider/UNKNOWN 边界；自主循环停止。`);
      }
      const assignment = await assignmentFor(missionId);
      let candidateId: string | undefined;
      if (assignment.constraints?.allowedKinds?.includes("api")) {
        const candidates = (await Promise.all(composition.assignmentCandidateSources.map(source => source.enumerateCandidates()))).flat();
        candidateId = candidates.filter(c => c.kind === "api" && c.availability === "available" && c.health?.status === "healthy"
          && assignment.constraints?.allowedProviders?.includes(c.provider)
          && (!assignment.constraints.requiredModel || c.models.includes(assignment.constraints.requiredModel))
          && Object.entries(assignment.constraints.requiredCapabilities ?? {}).every(([key, expected]) => c.capabilities[key as keyof typeof c.capabilities] === expected))
          .sort((a, b) => a.candidateId.localeCompare(b.candidateId))[0]?.candidateId;
      }
      if (!candidateId && assignment.constraints?.allowedKinds?.includes("web")) candidateId = (await ensureFreshUnboundPages(1))[0].candidateId;
      if (!candidateId) throw new Error("接班所需资源不可用；原 Worker 不退休、不重放。");
      await assertResourceScope();
      const replaced = await composition.succession.reconcile({
        projectId, rootMissionId: root.taskId, missionId, budget: request?.lifecycleBudget,
        assignment,
        exactCandidateId: candidateId,
      });
      if (replaced.state !== "replaced") throw new Error(`Mission ${missionId} 未完成同 Mission Worker 接班：${replaced.state}`);
    };

    const result = await vscode.window.withProgress({
      // Browser provider pages intentionally pause their native renderer while
      // a Notification overlay obscures them. Keeping the entire autonomy run
      // inside a notification therefore deadlocks the exact-page visibility
      // guard before the first provider send. Window progress remains visible
      // to the Human without covering the integrated browser.
      location: vscode.ProgressLocation.Window,
      title: "Nimora · 文理有界自主协作",
      cancellable: false,
    }, async () => {
      // A later root is born without Workers. Establish its two distinct roles
      // through the same assignment owner before asking Cognition for a plan.
      const initialIds = [scope.rootMissionId, scope.coordinationMissionId];
      const missing: string[] = [];
      for (const missionId of initialIds) {
        const task = await composition.owners.tasks.rereadTask(missionId);
        if (!task || task.missionFinalization) throw new Error("本轮 root/Coordinator 真值已变化。");
        const refs = Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
        const live = composition.owners.workers.listSessions({ taskId: missionId });
        if (!refs.length && !live.length) missing.push(missionId);
        else if (refs.length !== 1 || live.length !== 1 || refs[0].managedSessionId !== live[0].managedSessionId
          || refs[0].adapterSessionId !== live[0].adapterSessionId || refs[0].workerId !== live[0].workerId) throw new Error("本轮 Worker 绑定不完整，先核实原持久与宿主状态。");
      }
      if (missing.length) {
        if (resourcePolicy.planner === "api") {
          for (const missionId of missing) {
            const outcome = await composition.application.assignInitialWorker(await assignmentFor(missionId));
            if (outcome.state !== "assigned") throw new Error("本轮 API 总文或 Coordinator 不可用；未派发工作。");
          }
        } else {
        const pages = await ensureFreshUnboundPages(missing.length);
        for (let index = 0; index < missing.length; index++) {
          const outcome = await composition.application.assignInitialWorker({
            ...await assignmentFor(missing[index]),
          }, { exactCandidateId: pages[index].candidateId });
          if (outcome.state !== "assigned") throw new Error("新 root/Coordinator 未完整绑定；未派发本轮工作。");
        }
        }
      }
      return composition.autonomy.run(scope, {
        maxRounds: request?.maxRounds, maxParallel: resourcePolicy.maxParallel, ensureAssigned, ensureConversation,
      });
    });
    const outcomes = context.workspaceState.get<Record<string, { state: string; reason?: string; recordedAt: string }>>(AUTONOMY_OUTCOME_KEY, {});
    await context.workspaceState.update(AUTONOMY_OUTCOME_KEY, {
      ...outcomes,
      [projectId]: { state: result.state, reason: result.reason, recordedAt: new Date().toISOString() },
    });
    // This terminal notice has no action or authorization. Its promise resolves
    // only when dismissed; awaiting it would keep the product start busy after
    // the durable autonomy outcome is already recorded.
    void vscode.window.showInformationMessage(
      result.state === "completion-candidate"
        ? "Owning Cognition 已提出 Project 完成候选。自主循环已停止；请执行正式“审核并完成 Project”，机械 readiness 与独立完成审核仍不可跳过。"
        : `自主循环结束：${result.state}。原因：${result.reason}`,
    );
    return result;
  });
}
