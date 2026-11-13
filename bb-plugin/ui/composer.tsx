// Slots 4 and 5: a composer action that opens the Pi tab, and a composer popup
// (opened by a composer command or the + menu) that inserts a stash handle.
import { useComposer } from "@get-bb/plugin-sdk/app";
import { useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { StashSection } from "../contract.ts";
import { ago } from "./format.ts";
import { useComposerThread, useOpenSessionTab, useSession } from "./session.ts";

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

type Entry = StashSection["entries"][number];

/** The picker's list and keyboard handling; `onPick` receives the chosen entry. */
export function StashList({
  entries,
  onPick,
  onClose,
  now,
}: {
  entries: readonly Entry[];
  onPick: (entry: Entry) => void;
  onClose: () => void;
  now?: number;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? entries.filter((entry) =>
          `${entry.name} ${entry.description ?? ""}`.toLowerCase().includes(needle),
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
  const at = now ?? Date.now();
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
              key={entry.handle}
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
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-mono text-foreground">{entry.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {entry.lines} lines · {ago(entry.createdAt, at)}
                </span>
              </span>
              {entry.description ? (
                <span className="truncate text-xs text-muted-foreground">{entry.description}</span>
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
  const snapshot = useSession(useComposerThread());
  const entries = snapshot?.stash?.entries ?? [];
  const close = () => {
    composer.experimental_closePopup();
  };
  if (!snapshot?.stash)
    return <p className="p-3 text-sm text-muted-foreground">This thread has no Pi stash.</p>;
  return (
    <StashList
      entries={entries}
      onClose={close}
      onPick={(entry) => {
        composer.insert(`${entry.handle} `);
        close();
      }}
    />
  );
}
