import type { TUI, TuiMode } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { SessionMessage } from "#src/types";
import type { TranscriptSource } from "#src/ui/session-navigation";

/**
 * Minimal TUI double for transcript rendering: terminal dimensions, the render
 * mode, and a `requestRender` spy. Pi's per-entry components read nothing else
 * from it.
 */
export function mockTui(rows = 40, columns = 80, mode: TuiMode = "regular"): TUI {
  return { terminal: { rows, columns }, mode, requestRender: vi.fn() } as unknown as TUI;
}

/**
 * A `TranscriptSource` double with a single user message; override any method.
 * Shared by the overlay and transcript-content suites, which both consume the
 * source seam rather than a live record.
 */
export function fakeSource(overrides: Partial<TranscriptSource> = {}): TranscriptSource {
  return {
    getMessages: () => [{ role: "user", content: "Hello world" }] as unknown as SessionMessage[],
    subscribe: () => () => {},
    streaming: () => undefined,
    getToolDefinition: () => undefined,
    sessionModel: () => ({ model: undefined, thinkingLevel: undefined }),
    ...overrides,
  };
}
