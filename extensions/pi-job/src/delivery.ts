/**
 * What pi-job keeps of message delivery: the completion message type, and `dedupeCompletions`
 * for transcripts written by older versions.
 *
 * Delivery itself belongs to the work host (packages/pi-work): pi-job completes a work item with
 * the completion message and the host writes it into the transcript, wakes an idle session, and
 * continues a running one from `agent_before_settle`. Completions written by those older
 * versions carried several completions per message and could repeat one after a resend, which
 * the filter below still keeps out of the model's context.
 */
import type { ContextMessage } from "../../../packages/pi-work/src/index.ts";

/** Custom message type of completion messages. */
export const CUSTOM_TYPE = "job:completion";

interface CompletionRef {
  completionId: string;
  /** Content part of this completion's block; absent in older single-part messages. */
  part?: number;
}

/** Completions carried by a pi-job message (none for other messages or the round-2 format). */
export function completionRefs(message: ContextMessage): CompletionRef[] {
  if (message?.role !== "custom" || message.customType !== CUSTOM_TYPE) return [];
  const list = (
    message.details as { completions?: { completionId?: unknown; part?: unknown }[] } | undefined
  )?.completions;
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => typeof c?.completionId === "string" && c.completionId.length > 0)
    .map((c) => ({
      completionId: c.completionId as string,
      ...(Number.isInteger(c.part) ? { part: c.part as number } : {}),
    }));
}

export const DUPLICATE_STUB = "[pi-job: this completion was already delivered above; nothing new.]";

function stripped(count: number): string {
  return `[pi-job: ${count} completion${count === 1 ? "" : "s"} already shown above omitted.]\n\n`;
}

/**
 * Model-context filter, keyed on unique completion ids only (display handles such as `j1` are
 * never compared). In each pi-job message, the block of every completion already shown earlier
 * in the context is removed and replaced by a one-line note; unseen blocks are kept as they
 * are. A message left with no unseen completion becomes a one-line stub (kept, not removed, so
 * the context never ends on an assistant message). Messages without per-block part indices can
 * only be stubbed as a whole, when all their ids were seen. Returns undefined if nothing changed.
 */
export function dedupeCompletions<M extends ContextMessage>(messages: M[]): M[] | undefined {
  const seen = new Set<string>();
  let changed = false;
  const out = messages.map((m) => {
    const refs = completionRefs(m);
    if (refs.length === 0) return m;
    const repeats = refs.filter((r) => seen.has(r.completionId));
    for (const r of refs) seen.add(r.completionId);
    if (repeats.length === 0) return m;
    if (repeats.length === refs.length) {
      changed = true;
      return { ...m, content: [{ type: "text", text: DUPLICATE_STUB }] };
    }
    const parts = Array.isArray(m.content) ? m.content : undefined;
    const drop = new Set(repeats.map((r) => r.part));
    if (!parts || drop.has(undefined) || [...drop].some((i) => i! >= parts.length)) return m; // cannot split: keep whole
    changed = true;
    // Drop the repeated blocks and the batch header (its count is stale); say what was omitted.
    const blockParts = new Set(refs.map((r) => r.part));
    const kept = parts
      .map((part, i) => ({ part, i }))
      .filter(({ i }) => !drop.has(i) && (blockParts.has(i) || i > 0));
    // Keep details consistent with the new content (idempotent re-filtering): drop the omitted
    // completions and point the remaining ones at their new part index (after the note).
    const newIndex = new Map(kept.map(({ i }, k) => [i, k + 1]));
    const omitted = new Set(repeats.map((r) => r.completionId));
    const details = m.details as { completions: { completionId?: unknown; part?: unknown }[] };
    const completions = details.completions
      .filter((c) => !omitted.has(c?.completionId as string))
      .map((c) =>
        newIndex.has(c?.part as number) ? { ...c, part: newIndex.get(c.part as number) } : c,
      );
    return {
      ...m,
      content: [{ type: "text", text: stripped(repeats.length) }, ...kept.map((k) => k.part)],
      details: { ...details, completions },
    };
  });
  return changed ? out : undefined;
}
