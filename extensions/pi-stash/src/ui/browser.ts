import { errorText } from "../../../../packages/pi-foundations/src/errors.ts";
import {
  showExplorer,
  type Block,
  type ExplorerView,
  type Line,
  type ModalContext,
  type ModalOptions,
} from "../../../../packages/pi-ui/src/index.ts";
import { handleFor, type StashRecord } from "../state.ts";
import { entrySummary, formatAge, formatBytes, originLabel, shortSession } from "./render.ts";

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

/** Explorer snapshot. Previews load lazily on Enter; nothing reads the store before that. */
export function stashExplorerView(
  entries: readonly StashRecord[],
  load: (record: StashRecord) => StashPreview,
  warning?: string,
  now = Date.now(),
): ExplorerView {
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
    loadDetail: (id) => stashDetail(byId.get(id)!, load),
  };
}

/** Read-only list → detail modal. Owns no files or state beyond its snapshot. */
export async function showStashBrowser(
  ctx: ModalContext,
  entries: readonly StashRecord[],
  load: (record: StashRecord) => StashPreview,
  warning?: string,
  options: ModalOptions = {},
): Promise<void> {
  await showExplorer(ctx, stashExplorerView(entries, load, warning), {
    command: "/stash",
    ...options,
  });
}
