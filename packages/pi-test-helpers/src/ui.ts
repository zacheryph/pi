/**
 * Stand-ins for the interactive pieces of Pi's UI context (vitest only): a
 * terminal surface, and a `ui.custom` that mounts the component a factory
 * builds so the test can render it and send it keys.
 */
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { plainTheme, type TestTheme } from "#src/theme";

/** A terminal of `rows` x `columns` that records render requests. */
export function fakeTui(rows = 30, columns = 80) {
  return { terminal: { rows, columns }, requestRender: vi.fn(), isFollowingOutput: true };
}

export type FakeTui = ReturnType<typeof fakeTui>;

export const keybindings = () => new KeybindingsManager(TUI_KEYBINDINGS);

export interface FakeCustomUiOptions {
  theme?: TestTheme;
  /** The terminal handed to factories; extra members (such as `mode`) pass through. */
  tui?: FakeTui & Record<string, unknown>;
  /**
   * `ui.custom` resolves when the component calls `done`, as in Pi. Default
   * false: it resolves as soon as the component is mounted, with whatever
   * `done` received by then, so the test drives the component afterwards.
   */
  awaitDone?: boolean;
}

/* oxlint-disable typescript/no-explicit-any -- Factories are typed by each caller's component. */
type Factory = (tui: any, theme: any, keys: any, done: (value?: any) => void) => any;
/* oxlint-enable typescript/no-explicit-any */

/**
 * A `ui.custom` spy that builds each component with a fake terminal, the
 * theme and real keybindings, and keeps it in `components` (newest last).
 */
export function fakeCustomUi<Component = { render(width: number): string[] }>(
  options: FakeCustomUiOptions = {},
) {
  const tui = options.tui ?? fakeTui();
  const theme = options.theme ?? plainTheme;
  const components: Component[] = [];
  /** Every value a component passed to `done`. */
  const done = vi.fn<(value?: unknown) => void>();
  const custom = vi.fn(
    (factory: Factory, _options?: unknown) =>
      new Promise<unknown>((resolve) => {
        let result: unknown;
        const finish = (value?: unknown) => {
          result = value;
          done(value);
          if (options.awaitDone) resolve(value);
        };
        void Promise.resolve(factory(tui, theme, keybindings(), finish)).then((component) => {
          components.push(component as Component);
          if (!options.awaitDone) resolve(result);
        });
      }),
  );
  return {
    custom,
    tui,
    theme,
    components,
    done,
    /** The most recently mounted component. */
    latest: () => components.at(-1),
  };
}
