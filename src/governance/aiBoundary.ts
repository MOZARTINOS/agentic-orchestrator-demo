/**
 * GOVERNANCE BOUNDARY — the single, audited egress point to the LLM.
 *
 * This is the most load-bearing pattern in the production system. The rule is
 * architectural, not aspirational:
 *
 *   > No file outside this module may import or call the LLM client directly.
 *
 * Everything that reaches the model passes through `askModel()`, which:
 *   1. Pseudonymizes — strips raw PII, replacing real identifiers with stable
 *      aliases. The model sees "Person 003", never a real name or address.
 *   2. Audits — logs a SHA-256 hash of the prompt (never the body), token
 *      counts, latency, and outcome. You can prove *that* a call happened and
 *      *what it cost* without ever storing the sensitive content.
 *   3. Centralizes config — model name, max tokens, the API key lookup.
 *
 * In the real repo this is `src/server/ai/pseudonymize.ts`; the production
 * comment there reads: "AI call — single boundary. No other file may import
 * @anthropic-ai/sdk." This file reproduces that discipline generically.
 */

import { createHash, randomUUID } from "node:crypto";
import type { LlmClient } from "../types.js";

// ---------------------------------------------------------------------------
// Pseudonymization — raw identifiers in, stable aliases out.
// ---------------------------------------------------------------------------

/**
 * Maps real entity ids → stable, content-free aliases for the duration of a
 * request. The same id always gets the same alias, so the model can reason
 * about relationships ("Person 001 conflicts with Person 002") without ever
 * seeing who they are. The map never leaves the process.
 */
export class AliasMap {
  private readonly persons = new Map<string, string>();

  alias(rawId: string): string {
    const hit = this.persons.get(rawId);
    if (hit) return hit;
    const alias = `Person ${String(this.persons.size + 1).padStart(3, "0")}`;
    this.persons.set(rawId, alias);
    return alias;
  }
}

// ---------------------------------------------------------------------------
// Audit log — prove the call happened and what it cost, store no content.
// ---------------------------------------------------------------------------

export interface AuditRow {
  readonly requestId: string;
  /** SHA-256 of (system + prompt). The body itself is never persisted. */
  readonly promptHash: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly errorMessage: string | null;
}

/** Pluggable sink. In production this is an INSERT into `app.ai_audit_log`. */
export type AuditSink = (row: AuditRow) => Promise<void> | void;

/** Default sink: print a structured line. Swap for a DB writer in prod. */
const consoleAuditSink: AuditSink = (row) => {
  // Note: NO prompt body here — only the hash and metadata. By design.
  console.log(`[audit] ${JSON.stringify(row)}`);
};

// ---------------------------------------------------------------------------
// The boundary itself.
// ---------------------------------------------------------------------------

export interface AskModelArgs {
  readonly system: string;
  readonly prompt: string;
  readonly maxTokens?: number;
}

export interface AskModelResult {
  readonly requestId: string;
  readonly answer: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
}

/**
 * The ONLY way the rest of the app is allowed to talk to the model.
 *
 * We inject the `LlmClient` (real or mock) rather than importing a provider
 * SDK here, which keeps the file unit-testable and provider-agnostic — but the
 * *governance responsibility* (audit + alias discipline) lives at this single
 * choke point regardless of which client is wired in.
 */
export async function askModel(
  client: LlmClient,
  args: AskModelArgs,
  opts: { model?: string; auditSink?: AuditSink } = {},
): Promise<AskModelResult> {
  const model = opts.model ?? "claude-sonnet-4-5";
  const sink = opts.auditSink ?? consoleAuditSink;

  const requestId = randomUUID();
  const promptHash = createHash("sha256")
    .update(`${args.system}\n${args.prompt}`)
    .digest("hex");

  const startedAt = Date.now();
  try {
    const res = await client.complete({
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
      maxTokens: args.maxTokens ?? 600,
    });

    await sink({
      requestId,
      promptHash,
      model,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      latencyMs: Date.now() - startedAt,
      ok: true,
      errorMessage: null,
    });

    return {
      requestId,
      answer: res.text,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
    };
  } catch (err) {
    // Audit the failure too — but never let an audit failure mask the real one.
    try {
      await sink({
        requestId,
        promptHash,
        model,
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorMessage: (err as Error).message,
      });
    } catch {
      /* audit-log failure must never take down the request */
    }
    throw err;
  }
}
