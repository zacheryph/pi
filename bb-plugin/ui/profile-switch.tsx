// Slot 5's second popup: pi-subagent's `/subagent:switch` for bb, whose `/` menu does not list
// Pi's commands. The session lists its agent profiles (`subagent.profiles`); picking one runs
// `subagent.switch`, which compacts the conversation for that profile and then runs it. Pi
// answers at once and reports each step in the thread's timeline.
import { useComposer } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { useComposerThread, useRunAction, useSessionResult } from "./session.ts";

export const PROFILE_POPUP = "profile";
export const PROFILES_ACTION = "subagent.profiles";
export const SWITCH_ACTION = "subagent.switch";

/** One entry of `subagent.profiles`' answer. */
export interface ProfileChoice {
  name: string;
  label?: string;
  description?: string;
  running: boolean;
}

/** `subagent.profiles`' answer, keeping only well-formed entries. */
export function readProfiles(value: unknown): ProfileChoice[] {
  const profiles = (value as { profiles?: unknown } | null)?.profiles;
  if (!Array.isArray(profiles)) throw new Error("The session sent no agent profiles.");
  return profiles.flatMap((entry: unknown): ProfileChoice[] => {
    const { name, label, description, running } = (entry ?? {}) as Record<string, unknown>;
    if (typeof name !== "string" || !name) return [];
    return [
      {
        name,
        ...(typeof label === "string" && label ? { label } : {}),
        ...(typeof description === "string" && description ? { description } : {}),
        running: running === true,
      },
    ];
  });
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The profiles with a field for what the summary must keep. Up/Down move between the profiles
 * that are not running, Enter switches to the chosen one, Escape closes. `onSwitch` rejects with
 * the session's reason when it refuses, which shows under the list.
 */
export function ProfileList({
  profiles,
  onSwitch,
  onClose,
}: {
  profiles: readonly ProfileChoice[];
  onSwitch: (profile: string, keep: string) => Promise<void>;
  onClose: () => void;
}) {
  const choices = profiles.filter((profile) => !profile.running);
  const running = profiles.find((profile) => profile.running);
  const [keep, setKeep] = useState("");
  const [selected, setSelected] = useState(0);
  const [pending, setPending] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const current = Math.min(selected, Math.max(choices.length - 1, 0));

  const pick = (profile: ProfileChoice | undefined) => {
    if (!profile || pending) return;
    setPending(profile.name);
    setError(undefined);
    onSwitch(profile.name, keep.trim()).then(
      () => setPending(undefined),
      (reason: unknown) => {
        setPending(undefined);
        setError(errorMessage(reason));
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((current + step + choices.length) % Math.max(choices.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(choices[current]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-2 p-2" data-pi-surface="profile-switch">
      <p className="px-2 text-xs text-muted-foreground">
        Compact the conversation for another agent profile, then run it
        {running ? ` (running ${running.label ?? running.name})` : ""}.
      </p>
      <Input
        autoFocus
        value={keep}
        onChange={(event) => setKeep(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="What the summary must keep (optional)"
        aria-label="What the summary must keep"
        role="combobox"
        aria-expanded="true"
        aria-controls="pi-surface-profile-list"
        disabled={!!pending}
      />
      {choices.length === 0 ? (
        <p className="px-2 py-1 text-sm text-muted-foreground">No other agent profile can run.</p>
      ) : (
        <ul
          id="pi-surface-profile-list"
          role="listbox"
          aria-label="Agent profiles"
          className="flex flex-col"
        >
          {choices.map((profile, index) => (
            <li
              key={profile.name}
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
                pick(profile);
              }}
            >
              <span className="truncate text-sm">
                {profile.label ?? profile.name}
                {pending === profile.name ? (
                  <span className="text-muted-foreground"> · switching…</span>
                ) : null}
              </span>
              {profile.description ? (
                <span
                  className="truncate text-xs text-muted-foreground"
                  title={profile.description}
                >
                  {profile.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="px-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type Profiles =
  | { state: "loading" }
  | { state: "ready"; profiles: ProfileChoice[] }
  | { state: "error"; message: string };

export function ProfileSwitch() {
  const composer = useComposer();
  const threadId = useComposerThread();
  const { source } = useSessionResult(threadId);
  const run = useRunAction(threadId ?? "-", source);
  const [profiles, setProfiles] = useState<Profiles>({ state: "loading" });
  const close = () => {
    composer.experimental_closePopup();
  };

  useEffect(() => {
    if (!run) return;
    let live = true;
    setProfiles({ state: "loading" });
    run(PROFILES_ACTION, null).then(
      (value) => {
        if (!live) return;
        try {
          setProfiles({ state: "ready", profiles: readProfiles(value) });
        } catch (error) {
          setProfiles({ state: "error", message: errorMessage(error) });
        }
      },
      (error: unknown) => {
        if (live) setProfiles({ state: "error", message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [run]);

  if (!threadId || !run)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        Pi is not running for this thread. Send a message to start it, then switch.
      </p>
    );
  if (profiles.state === "loading")
    return <p className="p-3 text-sm text-muted-foreground">Loading agent profiles…</p>;
  if (profiles.state === "error")
    return <p className="p-3 text-sm text-destructive">{profiles.message}</p>;
  return (
    <ProfileList
      profiles={profiles.profiles}
      onClose={close}
      onSwitch={async (profile, keep) => {
        await run(SWITCH_ACTION, keep ? { profile, keep } : { profile });
        // Pi reports the compaction and the switch in the timeline from here.
        close();
      }}
    />
  );
}
