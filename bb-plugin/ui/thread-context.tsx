// Slots 2 and 3: the context row segment, and the thread context card's row and section.
import {
  experimental_ThreadContextCardRow as ThreadContextCardRow,
  useBbNavigate,
  type ExperimentalThreadContextCardProps,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import type { DeliverySnapshot, ExplorerItem, ExplorerModel } from "../contract.ts";
import {
  countText,
  openQuestionnaires,
  profileName,
  runningAgents,
  stashEntries,
  summaryModel,
  todoProgress,
  viewModel,
  VIEW,
} from "../views.ts";
import { plural } from "./format.ts";
import { useOpenGitTab, useOpenSessionTab, useSession } from "./session.ts";
import { BadgeText, LineText, plainText, URL_ONLY } from "./surface.tsx";

/**
 * `orchestrate · 3/7 tasks · 2 agents · question`, as one button that opens
 * the Pi tab. Every part is a summary's count, so it reads the same whether
 * or not the session shows its widgets.
 */
export function SegmentSummary({
  snapshot,
  onOpen,
}: {
  snapshot: DeliverySnapshot;
  onOpen?: () => void;
}) {
  const tasks = todoProgress(snapshot);
  const agents = runningAgents(snapshot);
  const parts = [
    profileName(snapshot) ?? "Pi",
    ...(tasks ? [`${tasks.done}/${tasks.total} tasks`] : []),
    ...(agents ? [plural(agents, "agent")] : []),
    ...(openQuestionnaires(snapshot).length ? ["question"] : []),
  ];
  // bb's segment padding (its CONTEXT_CARD_SEGMENT_CLASS): inside the row's
  // 4px inset it puts the icon 12px from the card edge, like the stack cards.
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
      title="Open the Pi session tab"
    >
      <Icon name="Layers" className="size-3.5 shrink-0" />
      <span className="truncate">{parts.join(" · ")}</span>
    </button>
  );
}

export function PiSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const snapshot = useSession(threadId);
  const open = useOpenSessionTab();
  return snapshot ? <SegmentSummary snapshot={snapshot} onOpen={() => void open()} /> : null;
}

export function StashCardRow({ threadId }: ExperimentalThreadContextCardProps) {
  const snapshot = useSession(threadId);
  const total = stashEntries(snapshot);
  const open = useOpenGitTab();
  if (!total) return null;
  // The summary's own text for the tooltip: `4 entries · 25.3 KiB on this branch`.
  const summary = summaryModel(snapshot, VIEW.stashSummary);
  const title = ["entries", "bytes"].flatMap((key) => countText(summary, key) ?? []).join(" · ");
  return (
    <ThreadContextCardRow
      icon="Paperclip"
      label="Stash"
      trailing={<span className="tabular-nums">{total}</span>}
      title={title}
      onClick={() => void open()}
    />
  );
}

/**
 * The explorers whose items the context card lists, with bb's icon for their
 * rows: a session's worktrees in use (the explorer's first tab) and every pull
 * request it touched.
 */
export const GIT_CARD: ReadonlyArray<{
  view: string;
  icon: string;
  items: "tab" | "all";
}> = [
  { view: VIEW.gitWorktrees, icon: "FolderGit", items: "tab" },
  { view: VIEW.gitPrs, icon: "GitPullRequest", items: "all" },
];

/** The items an explorer shows first: those of its initial tab, or all of them without tabs. */
export function initialItems(model: ExplorerModel): ExplorerItem[] {
  const tab = model.tabs?.[model.initialTab ?? 0];
  if (!tab) return [...model.items];
  const byId = new Map(model.items.map((item) => [item.id, item]));
  return tab.ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The first field of an item's included detail whose value is a bare http(s)
 * URL: the link the generic renderer opens in bb for that item.
 */
export function itemLink(item: ExplorerItem): string | undefined {
  if (typeof item.detail !== "object") return undefined;
  for (const block of item.detail)
    if ("fields" in block)
      for (const [, value] of block.fields) {
        const text = plainText(value);
        if (URL_ONLY.test(text)) return text;
      }
  return undefined;
}

/** Explorer items as context card rows: the item's label and badge, its link on click. */
export function ExplorerCardRows({
  snapshot,
  openUrl,
  onOpen,
}: {
  snapshot: DeliverySnapshot;
  openUrl?: (url: string) => void;
  onOpen?: () => void;
}) {
  return (
    <>
      {GIT_CARD.flatMap(({ view, icon, items }) => {
        const model = viewModel(snapshot, view, "explorer");
        if (!model) return [];
        return (items === "tab" ? initialItems(model) : model.items).map((item) => {
          const link = itemLink(item);
          const click = link && openUrl ? () => openUrl(link) : onOpen;
          return (
            <ThreadContextCardRow
              key={`${view}:${item.id}`}
              icon={icon}
              label={<LineText line={item.label} />}
              title={plainText(item.label)}
              {...(item.badge
                ? {
                    // The label comes first: a long status truncates within its own column.
                    trailing: (
                      <span className="block max-w-28 truncate" title={item.badge.text}>
                        <BadgeText badge={item.badge} />
                      </span>
                    ),
                  }
                : {})}
              {...(click ? { onClick: click } : {})}
            />
          );
        });
      })}
    </>
  );
}

export function GitCardSection({ threadId }: ExperimentalThreadContextCardProps) {
  const snapshot = useSession(threadId);
  const navigate = useBbNavigate();
  const open = useOpenGitTab();
  if (!snapshot) return null;
  const any = GIT_CARD.some(({ view, items }) => {
    const model = viewModel(snapshot, view, "explorer");
    return !!model && (items === "tab" ? initialItems(model) : model.items).length > 0;
  });
  if (!any) return null;
  return (
    <ExplorerCardRows
      snapshot={snapshot}
      openUrl={(url) => void navigate.openUrl(url)}
      onOpen={() => void open()}
    />
  );
}
