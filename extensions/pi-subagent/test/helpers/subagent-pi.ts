import { vi } from "vitest";
import { fakePi } from "../../../../packages/pi-test-helpers/src/fake-pi.ts";

/**
 * A fake `pi` with every ExtensionAPI member pi-subagent's composition root
 * touches at load time, for tests that load the whole extension. `extra` adds
 * or replaces members. `fire` runs every handler for an event in order, as Pi
 * fans one event out to all of an extension's handlers.
 */
export function subagentPi(extra: object = {}) {
  const fake = fakePi({
    registerMessageRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getActiveTools: vi.fn((): string[] => []),
    getAllTools: vi.fn((): { name: string }[] => []),
    registerShortcut: vi.fn(),
    exec: vi.fn(),
    ...extra,
  });
  return {
    // oxlint-disable-next-line typescript/no-explicit-any -- Tests reach into the spies freely.
    pi: fake.pi as any,
    tools: fake.tools,
    handlers: fake.handlers,
    fire: fake.emit,
  };
}
