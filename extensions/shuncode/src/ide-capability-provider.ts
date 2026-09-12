import type * as vscode from "vscode";

export interface IdeCapabilityProvider extends vscode.Disposable {
  readonly id: string;
  invoke(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult>;
  prepareInvocation?(name: string, input: Record<string, unknown>): Promise<vscode.PreparedToolInvocation | undefined>;
}

export function providerById(providers: readonly IdeCapabilityProvider[], providerId: string): IdeCapabilityProvider | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export function assertUniqueProviderIds(providers: readonly IdeCapabilityProvider[]): void {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Duplicate IDE capability provider id: ${provider.id}.`);
    ids.add(provider.id);
  }
}
