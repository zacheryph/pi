import { describe, expect, it } from "vitest";
import { ansiTheme, fakeCustomUi, fakeTui } from "#src/index";

type Probe = { render(width: number): string[]; close(value: string): void };
const factory = (
  tui: unknown,
  theme: typeof ansiTheme,
  _keys: unknown,
  done: (v: string) => void,
) => ({
  tui,
  render: (width: number) => [theme.bold(`w${width}`)],
  close: (value: string) => done(value),
});

describe("fakeCustomUi", () => {
  it("mounts the component and resolves at once by default", async () => {
    const ui = fakeCustomUi<Probe>({ theme: ansiTheme, tui: fakeTui(10, 40) });
    await expect(ui.custom(factory)).resolves.toBeUndefined();
    expect(ui.latest()!.render(5)).toEqual(["\x1b[1mw5\x1b[22m"]);
    ui.latest()!.close("x");
    expect(ui.done).toHaveBeenCalledWith("x");
  });

  it("resolves with the value passed to done when asked to wait", async () => {
    const ui = fakeCustomUi<Probe>({ awaitDone: true });
    const pending = ui.custom(factory);
    await Promise.resolve();
    ui.components[0]!.close("picked");
    await expect(pending).resolves.toBe("picked");
  });
});
