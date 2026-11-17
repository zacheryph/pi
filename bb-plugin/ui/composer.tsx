// Slots 4 and 5: a composer action that opens the Pi tab, and a composer popup
// (opened by a composer command or the + menu) that inserts a stash handle.
import { useComposer } from "@get-bb/plugin-sdk/app";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { ExplorerItem } from "../contract.ts";
import { viewModel, VIEW } from "../views.ts";
import { useComposerThread, useOpenSessionTab, useSession } from "./session.ts";
import { LineText, plainText } from "./surface.tsx";

export const STASH_POPUP = "stash";

export function OpenPanelAction() {
  const snapshot = useSession(useComposerThread());
  const open = useOpenSessionTab();
  if (!snapshot) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      aria-label="Open the Pi session tab"
      onClick={() => void open()}
    >
      <Icon name="Layers" className="size-4" />
    </Button>
  );
}

/**
 * The picker's list and keyboard handling over the `stash.explorer` view's
 * items, whose ids are the entries' handles; `onPick` receives the chosen one.
 * Filtering matches the item's label and search text, as the terminal's does.
 */
export function StashList({
  entries,
  onPick,
  onClose,
}: {
  entries: readonly ExplorerItem[];
  onPick: (entry: ExplorerItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? entries.filter((entry) =>
          `${plainText(entry.label)} ${entry.search ?? ""}`.toLowerCase().includes(needle),
        )
      : entries;
  }, [entries, query]);
  const current = Math.min(selected, Math.max(matches.length - 1, 0));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((current + step + matches.length) % Math.max(matches.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = matches[current];
      if (entry) onPick(entry);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <div className="flex w-full max-w-md flex-col gap-2 p-2" data-pi-surface="stash-picker">
      <Input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={onKeyDown}
        placeholder="Filter stash entries"
        aria-label="Filter stash entries"
        role="combobox"
        aria-expanded="true"
        aria-controls="pi-surface-stash-list"
      />
      {matches.length === 0 ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">No stash entries match.</p>
      ) : (
        <ul
          id="pi-surface-stash-list"
          role="listbox"
          aria-label="Stash entries"
          className="flex flex-col"
        >
          {matches.map((entry, index) => (
            <li
              key={entry.id}
              role="option"
              aria-selected={index === current}
              className={
                index === current
                  ? "flex cursor-pointer flex-col rounded-md bg-state-active px-2 py-1.5"
                  : "flex cursor-pointer flex-col rounded-md px-2 py-1.5 hover:bg-state-hover"
              }
              onMouseEnter={() => setSelected(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(entry);
              }}
            >
              <span className="truncate text-sm" title={plainText(entry.label)}>
                <LineText line={entry.label} />
              </span>
              {entry.badge ? (
                <span className="truncate text-xs text-muted-foreground">{entry.badge.text}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StashPicker() {
  const composer = useComposer();
  const explorer = viewModel(useSession(useComposerThread()), VIEW.stashExplorer, "explorer");
  const close = () => {
    composer.experimental_closePopup();
  };
  if (!explorer)
    return <p className="p-3 text-sm text-muted-foreground">This thread has no Pi stash.</p>;
  return (
    <StashList
      entries={explorer.items}
      onClose={close}
      onPick={(entry) => {
        // pi-stash names each item by its entry's handle, which the model can read back.
        composer.insert(`${entry.id} `);
        close();
      }}
    />
  );
}
