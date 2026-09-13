import * as vscode from "vscode";
import { capabilityRegistrySnapshot, type CapabilityMetadata } from "../../../src/capability-registry.js";
import { PromptingTaskCapabilityGrantResolver } from "../../../src/prompting-task-capability-grant-resolver.js";
import type { TaskCapabilityGrant, TaskSnapshot } from "../../../src/task-contract.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";

function riskDetail(capability: CapabilityMetadata): string {
  const parts = [`Risk: ${capability.risk}`];
  if (capability.destructive) parts.push("May modify or remove user-visible state");
  if (capability.openWorld) parts.push("May interact with resources outside the project");
  return parts.join(". ");
}

function isActiveGrant(task: TaskSnapshot, grant: TaskCapabilityGrant): boolean {
  if (grant.revokedAt) return false;
  if (grant.scope === "task") return true;
  if (!grant.managedSessionId || !grant.workerSessionAttachedAt) return false;
  const session = task.workerSessions[grant.managedSessionId];
  return !!session && !session.detachedAt && session.attachedAt === grant.workerSessionAttachedAt;
}

export function createInteractiveCapabilityGrantResolver(tasks: TaskRuntime, output: vscode.OutputChannel): PromptingTaskCapabilityGrantResolver {
  return new PromptingTaskCapabilityGrantResolver(tasks, {
    async requestGrant({ capability, scope }) {
      const scopeLabel = scope === "worker-session" ? "this AI session" : "this task";
      const allowLabel = scope === "worker-session" ? "Allow for this session" : "Allow for this task";
      const selected = await vscode.window.showWarningMessage(
        `Allow ${capability.title} for ${scopeLabel}?`,
        {
          modal: true,
          detail: `${riskDetail(capability)}. This permission can be revoked later from “Nimora: Manage AI Permissions”.`,
        },
        allowLabel,
      );
      const approved = selected === allowLabel;
      output.appendLine(`[permissions] ${approved ? "approved" : "denied"} capability=${capability.id} scope=${scope}`);
      return approved;
    },
  });
}

interface GrantQuickPickItem extends vscode.QuickPickItem {
  readonly taskId: string;
  readonly grantId: string;
  readonly capabilityTitle: string;
}

export function registerCapabilityGrantManagement(
  context: vscode.ExtensionContext,
  tasks: TaskRuntime,
): void {
  context.subscriptions.push(vscode.commands.registerCommand("shuncode.capabilities.managePermissions", async () => {
    await tasks.initialize();
    const capabilities = new Map(capabilityRegistrySnapshot().map(capability => [capability.id, capability]));
    const items: GrantQuickPickItem[] = [];
    for (const task of tasks.listTasks()) {
      for (const grant of Object.values(task.capabilityGrants)) {
        if (!isActiveGrant(task, grant)) continue;
        const capability = capabilities.get(grant.capabilityId);
        const capabilityTitle = capability?.title ?? grant.capabilityId;
        items.push({
          label: `$(shield) ${capabilityTitle}`,
          description: grant.scope === "worker-session" ? "Session permission" : "Task permission",
          detail: `${task.goal || "AI task"} • granted ${new Date(grant.grantedAt).toLocaleString()}`,
          taskId: task.taskId,
          grantId: grant.grantId,
          capabilityTitle,
        });
      }
    }
    if (items.length === 0) {
      await vscode.window.showInformationMessage("Nimora has no active AI permissions to revoke.");
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      title: "Nimora AI Permissions",
      placeHolder: "Choose a permission to revoke",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) return;
    const revoke = await vscode.window.showWarningMessage(
      `Revoke ${selected.capabilityTitle}?`,
      { modal: true, detail: "Future requests for this capability will require approval again." },
      "Revoke Permission",
    );
    if (revoke !== "Revoke Permission") return;
    await tasks.revokeCapabilityGrantStrict(selected.taskId, selected.grantId);
    await vscode.window.showInformationMessage(`${selected.capabilityTitle} permission revoked.`);
  }));
}
