/**
 * The orchestrator — a tiny, typed plan → act → observe loop.
 *
 * This is the heart of the "agentic orchestration" pattern. The model is NOT
 * in control of execution; the orchestrator is. The flow is:
 *
 *      goal
 *        │
 *        ▼
 *   ┌──────────┐   model proposes a typed Plan (JSON)
 *   │  PLAN     │ ──────────────────────────────────────►
 *   └──────────┘
 *        │
 *        ▼
 *   ┌──────────┐   for each step: validate args, run the tool,
 *   │  ACT      │   capture an Observation. Deterministic side
 *   └──────────┘   effects happen HERE, never inside the model.
 *        │
 *        ▼
 *   ┌──────────┐   feed observations back to the model for a
 *   │ OBSERVE   │   grounded, natural-language synthesis.
 *   └──────────┘
 *        │
 *        ▼
 *    RunTrace (answer + full audit trail)
 *
 * Key design choices (carried over from the production system):
 *   - The model's plan is *data*, validated before use — never executed blindly.
 *   - Every model call goes through the governance boundary (`askModel`).
 *   - The whole run is captured as a `RunTrace` for replay / debugging / audit.
 */

import { randomUUID } from "node:crypto";
import type {
  AnyTool,
  LlmClient,
  Observation,
  Plan,
  PlanStep,
  RunTrace,
} from "../types.js";
import { askModel, type AuditSink } from "../governance/aiBoundary.js";

const PLANNING_SYSTEM = [
  "You are a PLANNING agent.",
  "Given a goal and a list of available tools, respond with ONLY a JSON object",
  'of shape { "goal": string, "steps": [{ "tool": string, "args": object, "rationale": string }] }.',
  "Use only the tools provided. Do not invent tool names.",
].join(" ");

const SYNTHESIS_SYSTEM = [
  "You are a SYNTHESIS agent.",
  "You receive a goal and the observed results of executing a plan.",
  "Ground every claim in the observations. Be concise and action-oriented.",
].join(" ");

export interface OrchestratorDeps {
  readonly llm: LlmClient;
  readonly tools: ReadonlyMap<string, AnyTool>;
  readonly auditSink?: AuditSink;
}

/** Parse the model's plan text into a typed `Plan`, or throw a clear error. */
function parsePlan(raw: string, goal: string): Plan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Planner did not return valid JSON");
  }
  const obj = parsed as { steps?: unknown };
  if (!Array.isArray(obj.steps)) {
    throw new Error("Plan is missing a `steps` array");
  }
  const steps: PlanStep[] = obj.steps.map((s, i) => {
    const step = s as Partial<PlanStep>;
    if (typeof step.tool !== "string") {
      throw new Error(`Step ${i} has no tool name`);
    }
    return {
      tool: step.tool,
      args: step.args ?? {},
      rationale: typeof step.rationale === "string" ? step.rationale : "",
    };
  });
  return { goal, steps };
}

/** Run a single plan step against the registry, capturing an Observation. */
async function executeStep(
  step: PlanStep,
  tools: ReadonlyMap<string, AnyTool>,
): Promise<Observation> {
  const startedAt = Date.now();
  const tool = tools.get(step.tool);

  if (!tool) {
    return {
      step,
      ok: false,
      result: `No such tool: ${step.tool}`,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    // Validate the model's args at the boundary, THEN run. Never trust raw args.
    const input = tool.parse(step.args);
    const result = await tool.run(input);
    return { step, ok: true, result, durationMs: Date.now() - startedAt };
  } catch (err) {
    return {
      step,
      ok: false,
      result: (err as Error).message,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Run one full plan → act → observe cycle for a goal.
 *
 * Kept to a single pass for legibility. A production loop would iterate:
 * re-plan when observations reveal the plan was wrong, with a max-iteration
 * guard. The seams (typed plan, validated tools, audited model calls) are the
 * part worth studying — the loop count is an implementation detail.
 */
export async function runOrchestration(
  goal: string,
  deps: OrchestratorDeps,
): Promise<RunTrace> {
  const runId = randomUUID();
  const toolCatalog = [...deps.tools.values()]
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  // ---- PLAN -------------------------------------------------------------
  const planResp = await askModel(
    deps.llm,
    {
      system: PLANNING_SYSTEM,
      prompt: `Goal: ${goal}\n\nAvailable tools:\n${toolCatalog}`,
    },
    { auditSink: deps.auditSink },
  );
  const plan = parsePlan(planResp.answer, goal);

  // ---- ACT + OBSERVE ----------------------------------------------------
  const observations: Observation[] = [];
  for (const step of plan.steps) {
    observations.push(await executeStep(step, deps.tools));
  }

  // ---- SYNTHESIZE -------------------------------------------------------
  const observationDigest = observations
    .map(
      (o, i) =>
        `Step ${i + 1} (${o.step.tool}): ${o.ok ? "ok" : "FAILED"} → ${JSON.stringify(o.result)}`,
    )
    .join("\n");

  const synthResp = await askModel(
    deps.llm,
    {
      system: SYNTHESIS_SYSTEM,
      prompt: `Goal: ${goal}\n\nObservations:\n${observationDigest}`,
    },
    { auditSink: deps.auditSink },
  );

  return {
    runId,
    goal,
    plan,
    observations,
    answer: synthResp.answer,
    tokensIn: planResp.tokensIn + synthResp.tokensIn,
    tokensOut: planResp.tokensOut + synthResp.tokensOut,
  };
}
