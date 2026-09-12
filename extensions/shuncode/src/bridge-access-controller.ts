import * as vscode from "vscode";
import type { BridgeManager, BridgeStatus } from "./bridge-server.js";
import type { BridgeAccessSnapshot, BridgeLicenseService } from "./bridge-license-service.js";

const LICENSE_REVALIDATION_INTERVAL_MS = 15 * 60 * 1000;

export class BridgeAccessController implements vscode.Disposable {
  private validationTimer: ReturnType<typeof setInterval> | undefined;
  private validationInFlight = false;
  private usageReportInFlight = false;

  constructor(
    private readonly licenseService: BridgeLicenseService,
    private readonly bridge: BridgeManager,
    private readonly output: vscode.OutputChannel,
  ) {}

  async start(domain?: string): Promise<BridgeStatus> {
    const status = await this.bridge.start(domain);
    this.startValidationTimer();
    return status;
  }

  async stop(): Promise<BridgeStatus> {
    this.stopValidationTimer();
    void this.reportPendingUsage();
    return await this.bridge.stop();
  }

  async getAccessStatus(): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.getStatus();
  }

  async signIn(): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.signIn();
  }

  async signInWithGitee(): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.signInWithGitee();
  }

  async refreshSession(): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.refreshSession();
  }

  async refresh(): Promise<BridgeAccessSnapshot> {
    const snapshot = await this.licenseService.refresh();
    await this.stopIfAccessLost(snapshot, "license refresh");
    return snapshot;
  }

  async signOut(): Promise<BridgeAccessSnapshot> {
    if (this.bridge.getStatus().state === "running" || this.bridge.getStatus().state === "starting") {
      await this.stop();
    }
    return await this.licenseService.signOut();
  }

  async redeem(code: string): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.redeem(code);
  }

  async loadPlans(force = false): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.loadPlans(force);
  }

  async createPayment(planId: string, paymentType: string): Promise<BridgeAccessSnapshot> {
    return await this.licenseService.createPayment(planId, paymentType);
  }

  async getPaymentOrder(orderId = ""): Promise<BridgeAccessSnapshot> {
    const snapshot = await this.licenseService.getPaymentOrder(orderId);
    await this.stopIfAccessLost(snapshot, "payment/license update");
    return snapshot;
  }

  private startValidationTimer(): void {
    this.stopValidationTimer();
    this.validationTimer = setInterval(() => void this.revalidateRunningBridge(), LICENSE_REVALIDATION_INTERVAL_MS);
    this.validationTimer.unref?.();
  }

  private stopValidationTimer(): void {
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = undefined;
    }
  }

  private async revalidateRunningBridge(): Promise<void> {
    if (this.validationInFlight || this.bridge.getStatus().state !== "running") return;
    this.validationInFlight = true;
    try {
      await this.licenseService.requireFeature("bridge");
      await this.reportPendingUsage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[bridge-license] running Bridge authorization failed; stopping Bridge: ${message}`);
      await this.stop();
      await vscode.window.showWarningMessage(`ShunCode Bridge stopped because its license could not be renewed: ${message}`);
    } finally {
      this.validationInFlight = false;
    }
  }

  private async reportPendingUsage(): Promise<void> {
    if (this.usageReportInFlight) return;
    this.usageReportInFlight = true;
    try {
      const pending = this.bridge.takeToolCallsSinceLastReport();
      if (pending > 0) {
        const delivered = await this.licenseService.reportUsage(pending);
        if (!delivered) {
          this.bridge.returnToolCallsSinceLastReport(pending);
        }
      }
    } finally {
      this.usageReportInFlight = false;
    }
  }

  private async stopIfAccessLost(snapshot: BridgeAccessSnapshot, reason: string): Promise<void> {
    if (snapshot.licensed || this.bridge.getStatus().state === "stopped") return;
    this.output.appendLine(`[bridge-license] stopping Bridge after ${reason}: ${snapshot.error || "no active entitlement"}`);
    await this.stop();
  }

  dispose(): void {
    this.stopValidationTimer();
    void this.reportPendingUsage();
  }
}
