import type * as vscode from "vscode";
import { ProjectGovernanceHumanApplication } from "../../../src/project-governance-human-application.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";
import { createNimoraProductOperationalSource } from "./nimora-product-operations.js";
import { registerNimoraProductShell } from "./nimora-product-shell.js";

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;

/**
 * Thin Phase 12 registration seam. It owns no Project/Mission/Worker truth and
 * intentionally stays unreferenced by extension.ts until Phase 11 releases the
 * proof-sensitive production registration boundary.
 */
export function registerNimoraProductLayer(
  context: vscode.ExtensionContext,
  composition: Composition,
  productionWorkersReady: Promise<unknown>,
  onDidChange?: (listener: () => void) => vscode.Disposable,
): vscode.Disposable {
  const governance = new ProjectGovernanceHumanApplication(composition.owners.projects, composition.decisions);
  const operationalSource = createNimoraProductOperationalSource(composition, productionWorkersReady);
  return registerNimoraProductShell(
    context,
    {
      projects: composition.owners.projects,
      tasks: composition.owners.tasks,
      collaboration: composition.owners.collaboration,
    },
    onDidChange,
    governance,
    operationalSource,
  );
}
