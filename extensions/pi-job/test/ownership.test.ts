import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compatibleOwner,
  expireReloadOwner,
  highestJobId,
  sessionOwners,
  stopOrphans,
  takeReloadOwner,
  type Owner,
} from "../src/ownership.ts";
import { sleep } from "./helpers.ts";

void test("history high-water mark includes lists, old result text and completions, not other tools", () => {
  const entry = (message: any) => ({ type: "message", message });
  assert.equal(
    highestJobId([
      entry({ role: "toolResult", toolName: "job_list", details: { jobs: [{ id: "j31" }] } }),
      entry({
        role: "toolResult",
        toolName: "job_watch",
        content: [{ text: "Started watch j471: wait" }],
      }),
      {
        type: "custom_message",
        customType: "job:completion",
        details: { completions: [{ job: { id: "j544" } }] },
      },
      entry({ role: "toolResult", toolName: "Agent", details: { id: "j9999" } }),
    ]),
    544,
  );
});

void test("unknown owner and reload handoff are not proof of an orphan", async () => {
  let stopped = 0;
  const owner = (alive: () => boolean | undefined, token: object | undefined): Owner => ({
    version: 4,
    alive,
    token,
    manager: {
      shutdown: async () => {
        stopped++;
      },
      list: () => [{ status: "running" }],
    } as any,
    items: {
      dispose: () => {
        stopped++;
      },
    } as any,
  });
  const owners = new Map([
    ["live", owner(() => true, {})],
    ["unknown", owner(() => undefined, {})],
    ["reload", owner(() => false, undefined)],
  ]);
  assert.deepEqual(await stopOrphans(owners), []);
  assert.equal(stopped, 0);
  assert.equal(owners.size, 3);
});

function handoffOwner(): Owner {
  const noop = () => {};
  return {
    version: 4,
    alive: () => undefined,
    manager: Object.fromEntries(
      [
        "start",
        "watch",
        "get",
        "list",
        "output",
        "kill",
        "shutdown",
        "killAllSync",
        "advanceSequence",
        "notificationTail",
      ].map((name) => [name, noop]),
    ) as any,
    items: Object.fromEntries(
      ["open", "finished", "cancel", "adopt", "suspend", "bind", "release", "dispose"].map(
        (name) => [name, noop],
      ),
    ) as any,
  };
}

void test("reload timeout is unref'd, stops abandoned work and logs its owner", async (t) => {
  const owner = handoffOwner(),
    owners = new Map([["abandoned", owner]]);
  let stopped = 0;
  owner.manager.shutdown = async () => {
    stopped++;
  };
  const warnings: string[] = [];
  t.mock.method(console, "warn", (text: string) => warnings.push(text));
  expireReloadOwner("abandoned", owner, 10, owners);
  t.after(() => clearTimeout(owner.reloadTimer));
  assert.equal(owner.reloadTimer!.hasRef(), false);
  await sleep(40);
  assert.equal(stopped, 1);
  assert.equal(owners.has("abandoned"), false);
  assert.match(warnings[0], /abandoned.*expired.*stopping/);
});

void test("compatible adoption cancels handoff expiry", async (t) => {
  const owner = handoffOwner(),
    owners = sessionOwners();
  let stopped = false;
  owner.manager.shutdown = async () => {
    stopped = true;
  };
  owners.set("adopted", owner);
  t.after(() => {
    owners.delete("adopted");
    clearTimeout(owner.reloadTimer);
  });
  expireReloadOwner("adopted", owner, 10);
  assert.equal((await takeReloadOwner("adopted")).owner, owner);
  await sleep(40);
  assert.equal(stopped, false);
});

void test("an owner from before jobs were work items (version 3) is not adopted", () => {
  assert.equal(compatibleOwner({ ...handoffOwner(), version: 3 }), false);
  assert.equal(compatibleOwner({ ...handoffOwner(), version: 2 }), false);
  assert.equal(compatibleOwner(handoffOwner()), true);
});

void test("incompatible suspended owners are stopped, never adopted", async (t) => {
  const versionless = handoffOwner(),
    malformed = handoffOwner();
  const job = { id: "j1", kind: "watch", command: "echo full command; false", status: "running" };
  for (const owner of [versionless, malformed]) owner.manager.list = () => [job] as any;
  delete (versionless as any).version;
  delete (malformed.items as any).bind;
  let stopped = 0;
  for (const owner of [versionless, malformed])
    owner.manager.shutdown = async () => {
      stopped++;
    };
  const owners = sessionOwners();
  owners.set("versionless", versionless);
  owners.set("malformed", malformed);
  t.after(() => {
    owners.delete("versionless");
    owners.delete("malformed");
  });
  assert.equal(compatibleOwner(versionless), false);
  assert.equal(compatibleOwner(malformed), false);
  for (const id of ["versionless", "malformed"]) {
    const result = await takeReloadOwner(id);
    assert.equal(result.incompatible, true);
    assert.deepEqual(result.dropped, [job]);
  }
  assert.equal(stopped, 2);
  assert.equal(owners.has("versionless"), false);
  assert.equal(owners.has("malformed"), false);
});
