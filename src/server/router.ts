/**
 * Stub tRPC router — the typed RPC boundary between the UI and the
 * orchestration backend.
 *
 * This illustrates how the production frontend talks to the server: NOT via
 * loose REST strings, but through procedures whose input/output types are
 * inferred end to end. The React client gets full autocomplete and compile-time
 * safety on every call, and Zod validates input at the edge.
 *
 * The real system reaches the same orchestration logic through Next.js server
 * actions + tRPC procedures; this file shows the tRPC shape because it makes
 * the *typed contract* explicit. It is intentionally a skeleton — `initTRPC`
 * is sketched rather than wired to a running HTTP handler, so the file reads
 * cleanly without pulling in the full Next.js/@trpc runtime.
 */

import { runOrchestration } from "../orchestrator/orchestrator.js";
import { toolRegistry } from "../agents/tools.js";
import { createMockLlm } from "../llm/mockLlm.js";
import type { RunTrace } from "../types.js";

// ---------------------------------------------------------------------------
// In production:
//
//   import { initTRPC } from "@trpc/server";
//   import { z } from "zod";
//   const t = initTRPC.context<Ctx>().create({ transformer: superjson });
//   export const router = t.router;
//   export const publicProcedure = t.procedure;
//
// Below we model that surface with plain functions so the contract is visible
// without the framework. Swap these shims for the real `t.*` helpers verbatim.
// ---------------------------------------------------------------------------

/** Stand-in for `z.object(...).parse` — the real router uses Zod here. */
function parseRunInput(raw: unknown): { goal: string } {
  if (typeof raw !== "object" || raw === null || typeof (raw as any).goal !== "string") {
    throw new Error("Invalid input: expected { goal: string }");
  }
  const goal = (raw as any).goal.trim();
  if (goal.length === 0) throw new Error("goal must not be empty");
  return { goal };
}

/**
 * The orchestration router. One procedure: `orchestration.run`.
 *
 * Input:  { goal: string }
 * Output: RunTrace  (plan + observations + grounded answer + token cost)
 *
 * The return type flows to the client via tRPC's type inference — the UI knows
 * the exact shape of `RunTrace` with zero duplicated type declarations.
 */
export const appRouter = {
  orchestration: {
    /**
     * `publicProcedure.input(z.object({ goal: z.string() })).mutation(...)`
     * in real tRPC. Here it is a plain async function with the same contract.
     */
    run: async (rawInput: unknown): Promise<RunTrace> => {
      const input = parseRunInput(rawInput);

      // Dependencies are injected — the mock LLM here, the audited real client
      // in production. The router never imports a provider SDK; it only knows
      // the `LlmClient` interface and the governance boundary.
      return runOrchestration(input.goal, {
        llm: createMockLlm(),
        tools: toolRegistry,
      });
    },
  },
} as const;

/** The exported router type — what the typed client imports for inference. */
export type AppRouter = typeof appRouter;
