import path from "node:path";
import * as vscode from "vscode";
import { projectTaskCenterState, type TaskCenterTaskDetail } from "../../../src/task-center-projection.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";
import type { TaskShadowRecorder } from "./task-shadow.js";
import { buildTaskSessionEntryTree, buildTaskSessionFileTree, formatTaskSessionMarkdown, presentTaskSession, presentTaskSessionArtifacts, type TaskSessionPresentationStatus } from "./task-center-session-presentation.js";

export const NIMORA_TASK_SESSION_TYPE = "nimora-task";
export const MANAGED_TERMINAL_OPEN_COMMAND = "shuncode.terminal.openManaged";

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

function safeArtifactUri(value: string | undefined, workspace: string | undefined): vscode.Uri | undefined {
  if (!value) return undefined;
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(value, true);
  } catch {
    return undefined;
  }
  if (uri.scheme === "http" || uri.scheme === "https") return uri;
  if (uri.scheme !== "file" || !workspace) return undefined;
  const workspacePath = path.resolve(workspace);
  const artifactPath = path.resolve(uri.fsPath);
  const relative = path.relative(workspacePath, artifactPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return uri;
}

function safeWorkspaceFileUri(value: string, workspace: string | undefined): vscode.Uri | undefined {
  if (!workspace) return undefined;
  const workspacePath = path.resolve(workspace);
  const filePath = path.resolve(workspacePath, value);
  const relative = path.relative(workspacePath, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return vscode.Uri.file(filePath);
}

function createResponseParts(detail: TaskCenterTaskDetail): Array<vscode.ChatResponseMarkdownPart | vscode.ChatResponseFileTreePart | vscode.ChatResponseAnchorPart> {
  const parts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatResponseFileTreePart | vscode.ChatResponseAnchorPart> = [
    new vscode.ChatResponseMarkdownPart(new vscode.MarkdownString(formatTaskSessionMarkdown(detail))),
  ];
  const artifacts = presentTaskSessionArtifacts(detail);
  const workspaceFiles = [...new Set(artifacts
    .filter(artifact => artifact.kind === "changeset" || artifact.kind === "file")
    .flatMap(artifact => artifact.files))];
  if (detail.summary.workspace && workspaceFiles.length) {
    const tree = buildTaskSessionFileTree(workspaceFiles);
    if (tree.length) parts.push(new vscode.ChatResponseFileTreePart(tree, vscode.Uri.file(detail.summary.workspace)));
  }
  for (const artifact of artifacts) {
    if (detail.summary.workspace && artifact.entries.length) {
      const tree = buildTaskSessionEntryTree(artifact.entries);
      if (tree.length) parts.push(new vscode.ChatResponseFileTreePart(tree, vscode.Uri.file(detail.summary.workspace)));
    }
    const uri = safeArtifactUri(artifact.uri, detail.summary.workspace);
    if (uri) parts.push(new vscode.ChatResponseAnchorPart(uri, artifact.title));
    for (const location of artifact.locations) {
      const fileUri = safeWorkspaceFileUri(location.path, detail.summary.workspace);
      if (!fileUri) continue;
      const position = new vscode.Position(location.line - 1, Math.max(0, (location.column ?? 1) - 1));
      const target = new vscode.Location(fileUri, position);
      const locationLabel = `${location.path}:${location.line}${location.column ? `:${location.column}` : ""}`;
      parts.push(new vscode.ChatResponseAnchorPart(target, location.label ? `${locationLabel} · ${location.label}` : locationLabel));
    }
    if (artifact.content || artifact.terminal) {
      const markdown = new vscode.MarkdownString();
      markdown.appendMarkdown("### ");
      markdown.appendText(artifact.title);
      const terminal = artifact.terminal;
      if (terminal) {
        const details = [
          terminal.terminalName,
          terminal.status,
          terminal.execution,
          terminal.exitCode !== undefined ? `exit ${terminal.exitCode}` : undefined,
          terminal.cwd ? `cwd ${terminal.cwd}` : undefined,
          terminal.bytesSent !== undefined ? `${terminal.bytesSent} bytes sent` : undefined,
          terminal.outputLost ? "older output unavailable" : undefined,
          terminal.hasMore ? "more output available" : undefined,
        ].filter((value): value is string => Boolean(value));
        if (details.length) {
          markdown.appendMarkdown("\n\n");
          markdown.appendText(details.join(" · "));
        }
        if (terminal.command) {
          markdown.appendMarkdown("\n\n**Command**\n\n");
          markdown.appendCodeblock(terminal.command, "shell");
          if (terminal.commandTruncated) markdown.appendMarkdown("\n\n_Command truncated in Task history._");
        }
        if (terminal.openable && terminal.terminalId) {
          const target = vscode.Uri.from({
            scheme: "command",
            path: MANAGED_TERMINAL_OPEN_COMMAND,
            query: JSON.stringify([terminal.terminalId]),
          });
          markdown.isTrusted = { enabledCommands: [MANAGED_TERMINAL_OPEN_COMMAND] };
          markdown.appendMarkdown(`\n\n[Open terminal](${target.toString()})`);
        }
      }
      if (artifact.content) {
        markdown.appendMarkdown(terminal ? "\n\n**Output**\n\n" : "\n\n");
        markdown.appendCodeblock(artifact.content, artifact.contentLanguage);
        if (artifact.contentTruncated) markdown.appendMarkdown("\n\n_Content truncated in Work Sessions._");
      }
      parts.push(new vscode.ChatResponseMarkdownPart(markdown));
    }
  }
  return parts;
}

function createHistory(detail: TaskCenterTaskDetail, participantId: string): Array<vscode.ChatRequestTurn2 | vscode.ChatResponseTurn2> {
  const prompt = detail.summary.goal?.trim() || "Nimora Task";
  const request = new vscode.ChatRequestTurn2(prompt, undefined, [], participantId, [], undefined, `task:${detail.summary.taskId}`, undefined, undefined);
  const response = new vscode.ChatResponseTurn2(
    createResponseParts(detail),
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
