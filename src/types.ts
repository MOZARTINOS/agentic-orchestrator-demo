/**
 * Core type contracts for the agentic orchestrator.
 *
 * Everything else in `src/` is built on these. The whole point of the
 * architecture is that the *shapes* are defined once, here, and the
 * orchestrator, agents, tools, governance layer, and the tRPC boundary
 * all speak this same vocabulary.
 *
 * In the production system (Orkestrator AI) these live alongside the
 * domain model; here they are deliberately generic so the pattern is
 * legible without any business context.
 */

// ---------------------------------------------------------------------------
// Tools — a typed capability the model is allowed to invoke.
// ---------------------------------------------------------------------------

/**
 * A Tool is a *typed*, side-effect-bearing capability. The model never
 * touches the database or the network directly: it can only ask the
 * orchestrator to run one of these, by name, with validated input.
 *
 * `Input`/`Output` are generic so each tool stays strongly typed end to end.
 */
export interface Tool<Input = unknown, Output = unknown> {
  /** Stable identifier the model uses to call the tool (snake_case by convention). */
  readonly name: string;
  /** One-line description surfaced to the model in the tool-use schema. */
  readonly description: string;
  /**
   * Runtime validation. Returns a typed value or throws. In production this
   * is a Zod schema's `.parse`; here we keep a tiny hand-rolled validator so
   * the file has zero dependencies and stays readable.
   */
  readonly parse: (raw: unknown) => Input;
  /** The actual work. Pure-ish: depends only on `input` and injected deps. */
  readonly run: (input: Input) => Promise<Output>;
}

/** A tool with its generics erased — what a registry actually stores. */
export type AnyTool = Tool<any, any>;

// ---------------------------------------------------------------------------
// Plan — the model's proposed sequence of steps (the "plan" in plan→act→observe).
// ---------------------------------------------------------------------------

/** One unit of intended work the orchestrator will execute and observe. */
export interface PlanStep {
  /** Which tool to invoke. Must exist in the registry. */
  readonly tool: string;
  /** Arguments for the tool, validated by `tool.parse` before execution. */
  readonly args: unknown;
  /** Human-readable rationale — surfaced in the trace, never trusted as control flow. */
  readonly rationale: string;
}

/** A full plan plus the model's summary of intent. */
export interface Plan {
  readonly goal: string;
  readonly steps: readonly PlanStep[];
}

// ---------------------------------------------------------------------------
// Observations — the result of acting, fed back into the next loop iteration.
// ---------------------------------------------------------------------------

export interface Observation {
  readonly step: PlanStep;
  readonly ok: boolean;
  /** Tool output on success, error message on failure. */
  readonly result: unknown;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Run trace — the audit-friendly record of a whole orchestration.
// ---------------------------------------------------------------------------

export interface RunTrace {
  readonly runId: string;
  readonly goal: string;
  readonly plan: Plan;
  readonly observations: readonly Observation[];
  /** Final natural-language answer the orchestrator settled on. */
  readonly answer: string;
  /** Governance/cost accounting — see `governance/`. */
  readonly tokensIn: number;
  readonly tokensOut: number;
}

// ---------------------------------------------------------------------------
// LLM client — the single seam we mock. See `llm/`.
// ---------------------------------------------------------------------------

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

export interface LlmClient {
  /**
   * One stateless completion. The orchestrator drives the loop; the client
   * just turns (system + messages) into text. Production wraps the Anthropic
   * SDK behind exactly this interface so the rest of the app never imports it.
   */
  complete(args: {
    system: string;
    messages: readonly LlmMessage[];
    maxTokens?: number;
  }): Promise<LlmResponse>;
}
