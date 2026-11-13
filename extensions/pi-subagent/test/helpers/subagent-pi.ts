import { vi } from "vitest";
import { fakePi } from "#test-helpers";

/**
 * A fake `pi` with every ExtensionAPI member pi-subagent's composition root
 * touches at load time, for tests that load the whole extension. `extra` adds
 * or replaces members. `fire` runs every handler for an event in order, as Pi
 * fans one event out to all of an extension's handlers.
 */
export function subagentPi(extra: object = {}) {
  // oxlint-disable-next-line typescript/no-explicit-any -- Definitions are inspected loosely.
  const virtualModels = new Map<string, any>();
  const fake = fakePi({
    registerVirtualModel: vi.fn((model: { provider: string; id: string }) => {
      virtualModels.set(`${model.provider}/${model.id}`, model);
    }),
    unregisterVirtualModel: vi.fn((provider: string, id: string) => {
      virtualModels.delete(`${provider}/${id}`);
    }),
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
    /** Virtual models registered so far, keyed `provider/id`. */
    virtualModels,
    fire: fake.emit,
  };
}
