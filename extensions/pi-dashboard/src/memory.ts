import type { MemorySection } from "./protocol.ts";

// pi-blackhole has no public API; these are the custom entry types its memory
// ledger saves on the branch (pi-blackhole 0.5). Unknown shapes are skipped,
// and the section is omitted when none of its entries are present.
const OBSERVATIONS = ["om.observations.recorded", "om.observations.unanchored"];
const REFLECTIONS = "om.reflections.recorded";
const DROPPED = "om.observations.dropped";

interface Item {
  type?: unknown;
  customType?: unknown;
  timestamp?: unknown;
  data?: { observations?: unknown; reflections?: unknown; observationIds?: unknown };
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const id = (value: unknown): string | undefined =>
  value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : undefined;

export function memoryStats(branch: Iterable<unknown>): MemorySection {
  let compactions = 0;
  let lastCompactionAt: number | undefined;
  let ledger = false;
  const observations = new Map<string, number>();
  const reflections = new Set<string>();
  const dropped = new Set<string>();
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Item;
    if (item.type === "compaction") {
      compactions += 1;
      const at = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : NaN;
      if (Number.isFinite(at)) lastCompactionAt = at;
      continue;
    }
    if (item.type !== "custom" || typeof item.customType !== "string") continue;
    if (OBSERVATIONS.includes(item.customType)) {
      ledger = true;
      for (const observation of list(item.data?.observations)) {
        const key = id(observation);
        const tokens = (observation as { tokenCount?: unknown }).tokenCount;
        if (key)
          observations.set(
            key,
            typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
          );
      }
    } else if (item.customType === REFLECTIONS) {
      ledger = true;
      for (const reflection of list(item.data?.reflections)) {
        const key = id(reflection);
        if (key) reflections.add(key);
      }
    } else if (item.customType === DROPPED) {
      ledger = true;
      for (const key of list(item.data?.observationIds))
        if (typeof key === "string") dropped.add(key);
    }
  }
  let kept = 0;
  let keptTokens = 0;
  for (const [key, tokens] of observations) {
    if (dropped.has(key)) continue;
    kept += 1;
    keptTokens += tokens;
  }
  return {
    compactions,
    ...(lastCompactionAt !== undefined ? { lastCompactionAt } : {}),
    ...(ledger
      ? {
          blackhole: {
            observations: observations.size,
            kept,
            keptTokens,
            reflections: reflections.size,
            dropped: [...dropped].filter((key) => observations.has(key)).length,
          },
        }
      : {}),
  };
}
