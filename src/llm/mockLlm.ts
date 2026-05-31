/**
 * Mock LLM client — lets you read, run, and reason about the whole
 * orchestration WITHOUT an API key.
 *
 * This is the single seam the real system mocks. In production the only file
 * that imports `@anthropic-ai/sdk` is the governance boundary (see
 * `governance/aiBoundary.ts` here, `src/server/ai/pseudonymize.ts` in the
 * real repo). Everything upstream depends on the `LlmClient` interface, never
 * on a concrete provider — so the orchestrator is trivially testable.
 *
 * The mock is deterministic: given a goal, it emits a fixed plan and a fixed
 * final answer. It demonstrates the *protocol* (plan as JSON, then synthesis),
 * not real intelligence.
 */

import type { LlmClient, LlmResponse, LlmMessage } from "../types.js";

/** Crude token estimate — enough to exercise the cost-accounting path. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * A scripted client. We key off whether the system prompt asks for a PLAN or a
 * final ANSWER (the orchestrator uses two distinct system prompts), so the same
 * mock can serve both phases of the plan→act→observe loop.
 */
export function createMockLlm(): LlmClient {
  return {
    async complete({ system, messages, maxTokens }): Promise<LlmResponse> {
      const lastUser =
        [...messages].reverse().find((m: LlmMessage) => m.role === "user")?.content ?? "";

      const text = system.includes("PLANNING")
        ? mockPlan(lastUser)
        : mockSynthesis(lastUser);

      void maxTokens; // honored by the real client; ignored by the mock
      return {
        text,
        tokensIn: estimateTokens(system + lastUser),
        tokensOut: estimateTokens(text),
      } satisfies LlmResponse;
    },
  };
}

/**
 * Returns a JSON plan. The orchestrator parses this into a typed `Plan`.
 * We hand back a small, valid 2-step plan against the demo's tool names.
 */
function mockPlan(goal: string): string {
  const plan = {
    goal,
    steps: [
      {
        tool: "load_entity",
        args: { id: "entity-001" },
        rationale: "Pull the entity's current facts before reasoning about it.",
      },
      {
        tool: "detect_conflicts",
        args: { entityId: "entity-001" },
        rationale: "Run the deterministic rules engine to surface issues.",
      },
    ],
  };
  return JSON.stringify(plan, null, 2);
}

/** Returns the final natural-language synthesis, grounded in observations. */
function mockSynthesis(_context: string): string {
  return [
    "Summary: the entity is mildly overloaded and has one scheduling conflict.",
    "Biggest issue: a hard time-clash flagged by the rules engine (deterministic, not inferred).",
    "Suggested move: shift the lower-priority item to an open slot in the same zone.",
  ].join(" ");
}
