// Moves run longer than an RPC may wait (an import, a stopped turn, a slow provider), so `start` answers within a few
// seconds with the result or "pending", and `wait` picks it up. A repeated request (same request id) joins the move
// already running; a different move from the same agent while one runs is refused.

import type { StartOutput } from "../shared/rpc";
import type { Phase } from "./move";

export interface Operation {
  id: string;
  requestId: string;
  agentId: string;
  phase: Phase | "planning";
  promise: Promise<StartOutput>;
  result: StartOutput | null;
  finishedAt: number | null;
}

const KEEP_MS = 10 * 60_000;

export interface Operations {
  start(input: { requestId: string; agentId: string }, run: (phase: (phase: Phase) => void) => Promise<StartOutput>): Operation | "busy";
  get(id: string): Operation | null;
  /** The result when it comes within `ms`, else where the move is. */
  answer(operation: Operation, ms: number): Promise<StartOutput>;
}

export function createOperations(newId: () => string, now: () => number = Date.now): Operations {
  const byId = new Map<string, Operation>();
  const byRequest = new Map<string, Operation>();
  const bySource = new Map<string, Operation>();

  const prune = () => {
    for (const [id, operation] of byId) {
      if (operation.finishedAt !== null && now() - operation.finishedAt > KEEP_MS) {
        byId.delete(id);
        byRequest.delete(operation.requestId);
      }
    }
  };

  return {
    start(input, run) {
      prune();
      const repeated = byRequest.get(input.requestId);
      if (repeated) return repeated;
      const running = bySource.get(input.agentId);
      if (running && running.finishedAt === null) return "busy";
      const operation: Operation = { id: newId(), requestId: input.requestId, agentId: input.agentId, phase: "planning", promise: Promise.resolve(null as never), result: null, finishedAt: null };
      operation.promise = run((phase) => {
        operation.phase = phase;
      })
        .catch((error: unknown): StartOutput => ({ status: "refused", reason: { code: "errors.unexpected", params: { error: error instanceof Error ? error.message : String(error) } } }))
        .then((output) => {
          operation.result = output;
          operation.finishedAt = now();
          if (bySource.get(input.agentId) === operation) bySource.delete(input.agentId);
          return output;
        });
      byId.set(operation.id, operation);
      byRequest.set(input.requestId, operation);
      bySource.set(input.agentId, operation);
      return operation;
    },
    get(id) {
      return byId.get(id) ?? null;
    },
    async answer(operation, ms) {
      if (operation.result) return operation.result;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = new Promise<StartOutput>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending", opId: operation.id, phase: operation.phase }), ms);
      });
      try {
        return await Promise.race([operation.promise, pending]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
