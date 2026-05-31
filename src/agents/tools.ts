/**
 * Tool registry — the typed capabilities the orchestrator can invoke on the
 * model's behalf.
 *
 * Design rule mirrored from production: the model proposes *what* to do (by
 * tool name + args), but only this code decides *how* it happens. Tools are
 * the trust boundary for side effects — validation lives in `parse`, the work
 * lives in `run`, and the model never gets raw access to data stores.
 *
 * Two tools are shown:
 *   - `load_entity`     : fetch facts (here, from an in-memory fixture).
 *   - `detect_conflicts`: run a DETERMINISTIC rules engine — no LLM inference
 *                         for hard facts. This separation (rules decide truth,
 *                         the model only explains/prioritizes) is central to
 *                         the production design.
 */

import type { AnyTool, Tool } from "../types.js";

// ---------------------------------------------------------------------------
// Tiny in-memory fixture standing in for the database layer.
// ---------------------------------------------------------------------------

interface EntityFacts {
  readonly id: string;
  readonly loadPct: number; // assigned vs. contracted capacity
  readonly assignments: ReadonlyArray<{
    readonly day: number; // 1..7
    readonly start: string; // "HH:MM"
    readonly durationMin: number;
  }>;
}

const FIXTURE: Record<string, EntityFacts> = {
  "entity-001": {
    id: "entity-001",
    loadPct: 112, // over capacity
    assignments: [
      { day: 1, start: "09:00", durationMin: 60 },
      { day: 1, start: "09:30", durationMin: 60 }, // overlaps the first → time clash
      { day: 3, start: "14:00", durationMin: 45 },
    ],
  },
};

// ---------------------------------------------------------------------------
// Deterministic rules engine (no AI). Same spirit as the production
// conflict engine: pure functions over loaded facts.
// ---------------------------------------------------------------------------

export interface Conflict {
  readonly kind: "overload" | "time_clash";
  readonly severity: "warning" | "error";
  readonly label: string;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

function overlaps(aStart: number, aDur: number, bStart: number, bDur: number): boolean {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}

function detectConflicts(facts: EntityFacts): Conflict[] {
  const out: Conflict[] = [];

  if (facts.loadPct > 105) {
    out.push({
      kind: "overload",
      severity: "error",
      label: `Over capacity at ${facts.loadPct}%`,
    });
  }

  // Pairwise overlap within the same day → hard clash.
  const byDay = new Map<number, EntityFacts["assignments"][number][]>();
  for (const a of facts.assignments) {
    const arr = byDay.get(a.day) ?? [];
    arr.push(a);
    byDay.set(a.day, arr);
  }
  for (const [, group] of byDay) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (overlaps(toMinutes(a.start), a.durationMin, toMinutes(b.start), b.durationMin)) {
          out.push({
            kind: "time_clash",
            severity: "error",
            label: `Booked twice at once on day ${a.day} (${a.start} / ${b.start})`,
          });
        }
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tool definitions. Each `parse` is a hand-rolled stand-in for a Zod schema.
// ---------------------------------------------------------------------------

const loadEntity: Tool<{ id: string }, EntityFacts> = {
  name: "load_entity",
  description: "Load an entity's current facts (load %, assignments) by id.",
  parse(raw) {
    if (typeof raw !== "object" || raw === null || typeof (raw as any).id !== "string") {
      throw new Error("load_entity: expected { id: string }");
    }
    return { id: (raw as any).id };
  },
  async run({ id }) {
    const facts = FIXTURE[id];
    if (!facts) throw new Error(`Unknown entity: ${id}`);
    return facts;
  },
};

const detectConflictsTool: Tool<{ entityId: string }, Conflict[]> = {
  name: "detect_conflicts",
  description: "Run the deterministic rules engine over an entity and return conflicts.",
  parse(raw) {
    if (typeof raw !== "object" || raw === null || typeof (raw as any).entityId !== "string") {
      throw new Error("detect_conflicts: expected { entityId: string }");
    }
    return { entityId: (raw as any).entityId };
  },
  async run({ entityId }) {
    const facts = FIXTURE[entityId];
    if (!facts) throw new Error(`Unknown entity: ${entityId}`);
    return detectConflicts(facts);
  },
};

/** The registry the orchestrator looks tools up in, keyed by `name`. */
export const toolRegistry: ReadonlyMap<string, AnyTool> = new Map<string, AnyTool>([
  [loadEntity.name, loadEntity],
  [detectConflictsTool.name, detectConflictsTool],
]);
