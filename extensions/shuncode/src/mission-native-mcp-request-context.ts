import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import { taskArgumentsDigest } from "../../../src/task-runtime.js";
import type { MissionNativeMcpToolResult } from "./mission-native-mcp-binding.js";
import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";

interface RequestContext {
  controller: AbortController;
  response: ServerResponse;
  httpFinished: boolean;
  sentResult: boolean;
  completed: boolean;
  contentType?: string;
  prepared?: { requestId: string | number; digest: string; confirm: () => Promise<void> };
  onFailure: (error: unknown) => void;
}

/** Transient exact HTTP cancellation/submission evidence; no new durable owner. */
export class MissionNativeMcpRequestContext {
  private readonly requests = new AsyncLocalStorage<RequestContext>();

  currentSignal(protocolSignal: AbortSignal): AbortSignal {
    return AbortSignal.any([this.requireContext().controller.signal, protocolSignal]);
  }

  prepareSubmission(requestId: string | number, result: MissionNativeMcpToolResult, confirm: () => Promise<void>): void {
    const context = this.requireContext();
    context.controller.signal.throwIfAborted();
    if (context.prepared) throw new Error("Native MCP HTTP request already owns a prepared result.");
    context.prepared = { requestId, digest: taskArgumentsDigest(result), confirm };
  }

  /** Called only after the original SDK transport.send has resolved successfully. */
  async observeSentResponse(message: unknown): Promise<void> {
    const context = this.requests.getStore();
    if (!context?.prepared || context.completed || context.controller.signal.aborted) return;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (row.jsonrpc !== "2.0" || row.id !== context.prepared.requestId || "error" in row || !("result" in row)) return;
    if (taskArgumentsDigest(row.result) !== context.prepared.digest) return;
    context.sentResult = true;
    await this.confirmIfSubmitted(context);
  }

  /** Only the locally generated, successfully written modern SDK envelope is
   * passed here. Strip the spec's two wire-only stamps before comparing the
   * canonical result digest; never treat input_required/error as submission. */
  async observeModernSentResponse(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const row = message as Record<string, unknown>;
    if (!row.result || typeof row.result !== "object" || Array.isArray(row.result)) return;
    const result = { ...row.result as Record<string, unknown> };
    if (result.resultType !== "complete") return;
    delete result.resultType;
    if (result._meta && typeof result._meta === "object" && !Array.isArray(result._meta)) {
      const meta = { ...result._meta as Record<string, unknown> };
      delete meta[SERVER_INFO_META_KEY];
      if (Object.keys(meta).length) result._meta = meta; else delete result._meta;
    }
    await this.observeSentResponse({ ...row, result });
  }

  private requireContext(): RequestContext {
    const context = this.requests.getStore();
    if (!context) throw new Error("Mission-native MCP call lacks exact HTTP request context.");
    return context;
  }

  private async confirmIfSubmitted(context: RequestContext): Promise<void> {
    if (context.completed || context.controller.signal.aborted || !context.prepared
      || !context.httpFinished || !context.sentResult) return;
    const response = context.response;
    const contentType = String(response.getHeader("content-type") ?? context.contentType ?? "");
    if (response.statusCode < 200 || response.statusCode >= 300 || response.statusCode === 204
      || !/^(application\/json|text\/event-stream)(?:;|$)/i.test(contentType)) return;
    context.completed = true;
    try { await context.prepared.confirm(); }
    catch (error) { context.onFailure(error); }
  }

  async run<T>(request: IncomingMessage, response: ServerResponse, handle: () => Promise<T>,
    onFailure: (error: unknown) => void = () => {}): Promise<T> {
    const controller = new AbortController();
    const context: RequestContext = { controller, response, httpFinished: false, sentResult: false, completed: false, onFailure };
    // Node does not expose headers passed directly to writeHead via getHeader.
    // Observe the SDK adapter's public response call without changing it.
    const originalWriteHead = response.writeHead;
    response.writeHead = function (this: ServerResponse, statusCode, statusOrHeaders, headers) {
      const outgoing = typeof statusOrHeaders === "string" ? headers : statusOrHeaders;
      if (Array.isArray(outgoing)) {
        for (let index = 0; index < outgoing.length; index += 2) {
          if (String(outgoing[index]).toLowerCase() === "content-type") context.contentType = String(outgoing[index + 1]);
        }
      } else if (outgoing && typeof outgoing === "object") {
        for (const [name, value] of Object.entries(outgoing)) {
          if (name.toLowerCase() === "content-type") context.contentType = String(value);
        }
      }
      return Reflect.apply(originalWriteHead, this, Array.from(arguments));
    } as typeof response.writeHead;
    const cleanup = () => {
      response.writeHead = originalWriteHead;
      request.removeListener("aborted", cancel);
      response.removeListener("close", close);
      response.removeListener("finish", finish);
    };
    const cancel = () => {
      controller.abort(new Error("Mission-native MCP HTTP request disconnected before response completed."));
      cleanup();
    };
    const close = () => {
      if (!response.writableFinished) cancel();
      else cleanup();
    };
    const finish = () => {
      context.httpFinished = true;
      cleanup();
      void this.confirmIfSubmitted(context);
    };
    request.once("aborted", cancel);
    response.once("close", close);
    response.once("finish", finish);
    if (request.aborted || response.destroyed) cancel();
    try {
      return await this.requests.run(context, handle);
    } catch (error) {
      cancel();
      throw error;
    } finally {
      // SSE may return from handleRequest while its tool handler still awaits
      // permission. Retain cancellation until this response finishes/closes.
      // writableFinished may become true before Node emits finish. Removing
      // that listener here loses the only completed-response evidence.
      if (response.destroyed && !response.writableFinished) cancel();
    }
  }
}
