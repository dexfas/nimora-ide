import * as vscode from "vscode";
import { projectTaskCenterState, type TaskCenterTaskDetail } from "../../../src/task-center-projection.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";
import type { TaskShadowRecorder } from "./task-shadow.js";
import { formatTaskSessionMarkdown, presentTaskSession, type TaskSessionPresentationStatus } from "./task-center-session-presentation.js";

export const NIMORA_TASK_SESSION_TYPE = "nimora-task";

function taskResource(taskId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: NIMORA_TASK_SESSION_TYPE, path: `/${encodeURIComponent(taskId)}` });
}

function taskIdFromResource(resource: vscode.Uri): string | undefined {
  if (resource.scheme !== NIMORA_TASK_SESSION_TYPE) return undefined;
  const path = resource.path.replace(/^\/+/, "");
  if (!path) return undefined;
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

function vscodeStatus(status: TaskSessionPresentationStatus): vscode.ChatSessionStatus {
  switch (status) {
    case "failed": return vscode.ChatSessionStatus.Failed;
    case "completed": return vscode.ChatSessionStatus.Completed;
    case "needs_input": return vscode.ChatSessionStatus.NeedsInput;
    case "in_progress": return vscode.ChatSessionStatus.InProgress;
  }
}

function createHistory(detail: TaskCenterTaskDetail, participantId: string): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
  const prompt = detail.summary.goal?.trim() || "Nimora Task";
  const request = new vscode.ChatRequestTurn2(prompt, undefined, [], participantId, [], undefined, `task:${detail.summary.taskId}`, undefined, undefined);
  const response = new vscode.ChatResponseTurn2(
    [new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(formatTaskSessionMarkdown(detail)))],
    {},
    participantId,
  );
  return [request, response];
}

export function registerTaskCenterSessions(
  context: vscode.ExtensionContext,
  taskShadow: TaskShadowRecorder,
  participant: vscode.ChatParticipant,
  participantId: string,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const runtime: TaskRuntime = taskShadow.executionRuntime();
  const disposables: vscode.Disposable[] = [];
  let controller: vscode.ChatSessionItemController;
  let refreshQueued = false;

  const refresh = async (): Promise<void> => {
    await runtime.initialize();
    const state = projectTaskCenterState(runtime.listTasks());
    const items = state.tasks.map(summary => {
      const presentation = presentTaskSession(summary);
      const item = controller.createChatSessionItem(taskResource(summary.taskId), presentation.label);
      item.description = presentation.description;
      item.badge = presentation.badge;
      item.status = vscodeStatus(presentation.status);
      item.iconPath = new vscode.ThemeIcon("tasklist");
      item.timing = {
        created: presentation.createdAt,
        lastRequestStarted: presentation.updatedAt,
        lastRequestEnded: presentation.terminal ? presentation.updatedAt : undefined,
      };
      item.metadata = {
        nimoraTaskId: summary.taskId,
        sourceKind: summary.sourceKind,
        workerCount: summary.workerCount,
        activeWorkerCount: summary.activeWorkerCount,
        executionCount: summary.executionCounts.total,
        pendingDeliveryCount: summary.executionCounts.pendingDelivery,
        artifactCount: summary.artifactCount,
      };
      return item;
    });
    controller.items.replace(items);
  };

  controller = vscode.chat.createChatSessionItemController(NIMORA_TASK_SESSION_TYPE, async token => {
    if (token.isCancellationRequested) return;
    await refresh();
  });
  disposables.push(controller);

  disposables.push(vscode.chat.registerChatSessionContentProvider(
    NIMORA_TASK_SESSION_TYPE,
    {
      async provideChatSessionContent(resource, token) {
        if (token.isCancellationRequested) throw new vscode.CancellationError();
        const taskId = taskIdFromResource(resource);
        if (!taskId) throw new Error("Invalid Nimora Task session resource.");
        await runtime.initialize();
        const state = projectTaskCenterState(runtime.listTasks(), taskId);
        const detail = state.selected;
        if (!detail) throw new Error(`Nimora Task is no longer available: ${taskId}`);
        return {
          title: detail.summary.goal || "Nimora Task",
          history: createHistory(detail, participantId),
          requestHandler: undefined,
        };
      },
    },
    participant,
  ));

  disposables.push(taskShadow.onDidChangeTask(() => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      void refresh().catch(error => output.appendLine(`[task-center] session refresh failed: ${error instanceof Error ? error.message : String(error)}`));
    });
  }));

  void refresh().catch(error => output.appendLine(`[task-center] initial session refresh failed: ${error instanceof Error ? error.message : String(error)}`));

  const disposable = vscode.Disposable.from(...disposables);
  context.subscriptions.push(disposable);
  output.appendLine("[task-center] Nimora Work Sessions registered on the native Sessions provider surface");
  return disposable;
}
