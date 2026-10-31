import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPreservedWorktreesCommand } from "#src/preserved-command";

const FIRST = "/private/tmp/pi-agent-abc123-1f2e9c04";
const SECOND = "/private/tmp/pi-agent-def456-90ab77e1";

/** Register the command and hand back the pieces a test drives it with. */
function registerCommand(preserved: string[]) {
  const discard = vi.fn();
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    registerCommand: vi.fn(
      (
        _name: string,
        options: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        handler = options.handler;
      },
    ),
  };

  registerPreservedWorktreesCommand(pi as never, {
    findPreserved: () => preserved,
    discard,
  });

  const select = vi.fn(async (): Promise<string | undefined> => undefined);
  const confirm = vi.fn(async () => false);
  const notify = vi.fn();
  const run = async () =>
    handler?.("", { ui: { select, confirm, notify } as never });

  return { pi, discard, select, confirm, notify, run };
}

describe("registerPreservedWorktreesCommand", () => {
  let command: ReturnType<typeof registerCommand>;

  beforeEach(() => {
    command = registerCommand([FIRST, SECOND]);
  });

  it("registers under the package's own command name", () => {
    expect(command.pi.registerCommand).toHaveBeenCalledWith(
      "subagents-worktrees",
      expect.objectContaining({ description: expect.any(String) }),
    );
  });

  it("reports an empty result without opening a selector", async () => {
    const empty = registerCommand([]);

    await empty.run();

    expect(empty.notify).toHaveBeenCalledWith(
      "No preserved rescue worktrees found.",
      "info",
    );
    expect(empty.select).not.toHaveBeenCalled();
  });

  it("offers every preserved worktree plus a way out", async () => {
    await command.run();

    expect(command.select).toHaveBeenCalledWith("Preserved rescue worktrees", [
      FIRST,
      SECOND,
      "Close",
    ]);
  });

  it("removes nothing when the selector is dismissed", async () => {
    await command.run();

    expect(command.confirm).not.toHaveBeenCalled();
    expect(command.discard).not.toHaveBeenCalled();
  });

  it("removes nothing when the way out is chosen", async () => {
    command.select.mockResolvedValue("Close");

    await command.run();

    expect(command.confirm).not.toHaveBeenCalled();
    expect(command.discard).not.toHaveBeenCalled();
  });

  it("removes nothing when the confirmation is declined", async () => {
    command.select.mockResolvedValue(FIRST);

    await command.run();

    expect(command.confirm).toHaveBeenCalledTimes(1);
    expect(command.discard).not.toHaveBeenCalled();
  });

  it("removes the chosen worktree once confirmed", async () => {
    command.select.mockResolvedValue(SECOND);
    command.confirm.mockResolvedValue(true);

    await command.run();

    expect(command.discard).toHaveBeenCalledWith(SECOND);
    expect(command.notify).toHaveBeenCalledWith(`Removed ${SECOND}.`, "info");
  });

  it("reports a removal that fails instead of throwing", async () => {
    command.select.mockResolvedValue(FIRST);
    command.confirm.mockResolvedValue(true);
    command.discard.mockImplementation(() => {
      throw new Error("worktree is dirty");
    });

    await expect(command.run()).resolves.toBeUndefined();

    expect(command.notify).toHaveBeenCalledWith(
      `Could not remove ${FIRST}: worktree is dirty`,
      "error",
    );
  });
});
