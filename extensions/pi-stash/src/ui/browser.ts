import { errorText } from "#foundations/errors";
import { isJsonObject, type ActionBus, type ActionDefinition } from "#surface";
import {
  showExplorer,
  type Block,
  type ExplorerModel,
  type Line,
  type ModalContext,
  type ModalOptions,
} from "#ui";
import { STASH_INSPECT_ACTION } from "#src/events";
import { handleFor, type StashRecord } from "#src/state";
import { entrySummary, formatAge, formatBytes, originLabel, shortSession } from "#src/ui/render";

export interface StashPreview {
  lines: string[];
  /** Shown after the lines, e.g. when the preview stops before the end. */
  note?: string;
}

/** Metadata always renders; a read failure replaces only the contents section. */
export function stashDetail(record: StashRecord, load: (record: StashRecord) => StashPreview) {
  const storedBy =
    `${originLabel(record)}${record.agent ? ` (session ${shortSession(record.createdBy)})` : ""}` +
    (record.via === "adopt" ? " · adopted from a subagent" : "");
  const blocks: Block[] = [
    {
      fields: [
        ["Name", record.name],
        ["Hash", record.hash],
        ["Description", record.description || "—"],
        ["Stored by", storedBy],
      ],
    },
    { heading: "Contents" },
  ];
  try {
    const preview = load(record);
    blocks.push({ lines: preview.lines, numbered: 1 });
    if (preview.note) blocks.push({ text: `\n${preview.note}`, tone: "muted" });
  } catch (error) {
    blocks.push({ text: `Couldn't read: ${errorText(error)}`, tone: "error" });
  }
  return blocks;
}

/**
 * `stash.inspect` with `{ id: <handle> }`: one entry's detail blocks, for a user
 * who opened it. Only handles of entries on this branch resolve.
 */
export function stashInspectAction(
  find: (handle: string) => StashRecord | undefined,
  load: (record: StashRecord) => StashPreview,
): ActionDefinition<{ id: string }> {
  return {
    id: STASH_INSPECT_ACTION,
    title: "Show a stash entry's details and content preview",
    parse: (args) => {
      if (!isJsonObject(args) || typeof args.id !== "string")
        throw new Error("expected { id: <stash handle> }");
      return { id: args.id };
    },
    handler: ({ id }) => {
      const record = find(id);
      if (!record) throw new Error(`No stash entry ${id} on this branch.`);
      return stashDetail(record, load);
    },
  };
}

/** Explorer model, plain JSON. Previews load lazily on Enter through `stash.inspect`. */
export function stashExplorerView(
  entries: readonly StashRecord[],
  warning?: string,
  now = Date.now(),
): ExplorerModel {
  const byId = new Map(entries.map((entry) => [handleFor(entry), entry]));
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const notices: Line[] = [];
  if (warning) notices.push({ text: warning, tone: "warning" });
  notices.push({ text: `${formatBytes(total)} stored on this branch`, tone: "muted" });
  return {
    title: "Stash",
    noun: ["entry", "entries"],
    notices,
    emptyText: "No stash entries on this branch.",
    items: [...byId].map(([id, record]) => ({
      id,
      label: [
        { text: id, tone: "accent" },
        ...(record.description
          ? [{ text: ` — ${record.description}`, tone: "muted" as const }]
          : []),
      ],
      search: record.name,
      badge: {
        text: `${record.via === "adopt" ? `↑ ${originLabel(record)} · ` : ""}${entrySummary(record)} · ${formatAge(record.createdAt, now)}`,
      },
    })),
    loadDetail: { action: STASH_INSPECT_ACTION },
  };
}

/** Read-only list → detail modal. `actions` is the session's bus where `stash.inspect` is defined. */
export async function showStashBrowser(
  ctx: ModalContext,
  entries: readonly StashRecord[],
  actions: ActionBus,
  warning?: string,
  options: ModalOptions = {},
): Promise<void> {
  await showExplorer(ctx, stashExplorerView(entries, warning), {
    command: "/stash",
    ...options,
    actions,
  });
}
