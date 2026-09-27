import { createHash } from "node:crypto";
import {
  ListSessionTasksResponseSchema,
  SessionSchema,
  TraceGraphViewV2Schema,
  type ResearchExecutionSnapshot,
  type ResearchExecutionTarget,
} from "@brainpilot/protocol";
import type { z } from "zod";
import { ResearchRecordError } from "./research-store.js";
import type { RuntimeClient } from "./runtime-client.js";

export class ResearchRuntimeUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Runtime could not be checked; try again when it is available", { cause });
    this.name = "ResearchRuntimeUnavailableError";
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Only read Runtime's public API; never inspect or edit its on-disk ledger. */
export function createResearchRuntimeResolver(getClient: () => Promise<RuntimeClient>) {
  async function read<T>(route: "getSession" | "listSessionTasks" | "getTrace", sessionId: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try { response = await (await getClient()).forward(route, { params: { id: sessionId } }); }
    catch (error) { throw new ResearchRuntimeUnavailableError(error); }
    if (response.status === 404) throw new ResearchRecordError("Runtime session or target no longer exists", 404);
    if (!response.ok) throw new ResearchRuntimeUnavailableError(new Error(`Runtime returned ${response.status}`));
    try { return schema.parse(await response.json()); }
    catch (error) { throw new ResearchRuntimeUnavailableError(error); }
  }

  return async (sessionId: string, target: ResearchExecutionTarget): Promise<ResearchExecutionSnapshot> => {
    const session = await read("getSession", sessionId, SessionSchema);
    if (session.id !== sessionId) throw new ResearchRuntimeUnavailableError(new Error("Runtime session identity mismatch"));
    const sessionTitle = session.title.slice(0, 2000);
    if (target.kind === "session") {
      // Runtime updates this metadata when the session receives new work. An ID
      // alone would keep a link "current" even after its execution changed.
      return { sessionTitle, targetLabel: sessionTitle, fingerprint: fingerprint(session) };
    }
    if (target.kind === "task") {
      const { tasks } = await read("listSessionTasks", sessionId, ListSessionTasksResponseSchema);
      const task = tasks.find((record) => record.id === target.id);
      if (!task) throw new ResearchRecordError("Runtime task not found in this session", 404);
      return {
        sessionTitle,
        targetLabel: `${task.id} · ${task.content.slice(0, 160)}`,
        fingerprint: fingerprint(task),
      };
    }

    const trace = await read("getTrace", sessionId, TraceGraphViewV2Schema);
    if (trace.meta.sessionId !== sessionId) {
      throw new ResearchRuntimeUnavailableError(new Error("Runtime trace session identity mismatch"));
    }
    if (target.kind === "trace_node") {
      const node = trace.nodes.find((record) => record.id === target.id);
      if (!node || node.id === trace.meta.rootNodeId || node.revoked) {
        throw new ResearchRecordError("Runtime trace node not found", 404);
      }
      return {
        sessionTitle, targetLabel: node.title.slice(0, 2000), traceRevision: trace.revision,
        fingerprint: fingerprint({
          id: node.id, title: node.title, type: node.type, status: node.status,
          report: node.report, artifactIds: node.artifactIds, executionResult: node.executionResult,
          revoked: node.revoked, reviewConclusion: node.reviewConclusion,
        }),
      };
    }

    const artifact = trace.artifacts.find((record) => record.id === target.id);
    if (!artifact || artifact.role !== "output" || artifact.exists !== "present" || artifact.verificationStatus !== "verified") {
      throw new ResearchRecordError("Verified Runtime output artifact not found", 404);
    }
    const producer = artifact.producerNodeId
      ? trace.nodes.find((node) => node.id === artifact.producerNodeId)
      : undefined;
    if (artifact.producerNodeId && (!producer || producer.id === trace.meta.rootNodeId || producer.revoked)) {
      throw new ResearchRecordError("Runtime artifact producer not found", 404);
    }
    return {
      sessionTitle, targetLabel: artifact.path.slice(0, 2000), traceRevision: trace.revision,
      fingerprint: fingerprint({
        id: artifact.id, path: artifact.path, kind: artifact.kind, type: artifact.type,
        blobHash: artifact.blobHash, checkpointId: artifact.checkpointId,
        exists: artifact.exists, verificationStatus: artifact.verificationStatus,
        role: artifact.role, producerNodeId: artifact.producerNodeId,
        producerRevoked: producer?.revoked, producerExecutionResult: producer?.executionResult,
      }),
      ...(artifact.blobHash ? { contentHash: artifact.blobHash } : {}),
    };
  };
}
