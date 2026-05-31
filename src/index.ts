/**
 * Runnable entrypoint — exercises the whole pattern end to end against the
 * MOCK LLM. No API key required.
 *
 *   $ npm install
 *   $ npm run demo
 *
 * It calls the tRPC-style router exactly as the UI would, prints the resulting
 * run trace (plan, per-step observations, grounded answer, token cost), and
 * renders the visual workflow graph the production canvas would draw.
 */

import { appRouter } from "./server/router.js";
import { traceToGraph } from "./graph/workflowGraph.js";

async function main(): Promise<void> {
  // Exactly the call the React client makes: trpc.orchestration.run.mutate(...)
  const trace = await appRouter.orchestration.run({
    goal: "Review entity-001 and recommend one fix.",
  });

  console.log("\n=== RUN TRACE ===");
  console.log(`runId: ${trace.runId}`);
  console.log(`goal:  ${trace.goal}`);

  console.log("\n--- Plan ---");
  trace.plan.steps.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.tool}  // ${s.rationale}`);
  });

  console.log("\n--- Observations ---");
  trace.observations.forEach((o, i) => {
    console.log(`  ${i + 1}. ${o.step.tool}: ${o.ok ? "ok" : "FAILED"} (${o.durationMs}ms)`);
    console.log(`     ${JSON.stringify(o.result)}`);
  });

  console.log("\n--- Answer (grounded synthesis) ---");
  console.log(`  ${trace.answer}`);

  console.log(`\n--- Cost ---\n  tokensIn=${trace.tokensIn} tokensOut=${trace.tokensOut}`);

  const graph = traceToGraph(trace);
  console.log(`\n--- Visual workflow graph ---`);
  console.log(`  nodes: ${graph.nodes.length}, edges: ${graph.edges.length}`);
  console.log(`  ${graph.nodes.map((n) => `${n.type}:${n.data.label}`).join("  →  ")}`);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
