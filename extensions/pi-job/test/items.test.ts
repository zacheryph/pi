/** JobItems with a fake host and manager (no pi, no processes). */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  WorkHost,
  WorkItem,
  WorkItemSpec,
  WorkMessage,
} from "../../../packages/pi-work/src/index.ts";
import { JobItems, WORK_OWNER } from "../src/items.ts";
import type { JobManager, JobSnapshot } from "../src/jobs.ts";

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "j1",
  kind: "command",
  command: "make test",
  cwd: "/",
  logPath: "/logs/j1.log",
  startedAt: 0,
  status: "running",
  timeoutSeconds: 10,
  ...over,
});

/** A host that records what happens to the items it hands out. */
function fakeHost() {
  const log: string[] = [];
  const specs: WorkItemSpec[] = [];
  const handle = (spec: WorkItemSpec, id: string): WorkItem => ({
    ...spec,
    id,
    openedAt: 0,
    notify: () => void log.push(`notify ${id}`),
    complete: (message: WorkMessage) =>
      void log.push(`complete ${id} ${JSON.stringify(message.content).slice(1, -1)}`),
    cancel: () => void log.push(`cancel ${id}`),
  });
  const host: WorkHost = {
    open: (spec) => {
      specs.push(spec);
      return handle(spec, `item${specs.length}`);
    },
    adopt: () => {},
    list: () => [],
  };
  return { host, log, specs, handle };
}

const manager = (jobs: JobSnapshot[]) => ({ get: (id: string) => jobs.find((j) => j.id === id) });

function setup(jobs: JobSnapshot[] = [job()]) {
  const fake = fakeHost();
  const items = new JobItems(manager(jobs) as unknown as JobManager, (j) => ({
    customType: "job:completion",
    content: `done ${j.id}`,
  }));
  items.bind(() => fake.host, "s1");
  return { ...fake, items };
}

void test("opening persists what is needed to recognize the job again", () => {
  const { items, specs } = setup();
  items.open(job({ label: "build" }));
  items.open(job({ id: "j2", kind: "watch", logPath: "/logs/j2.log" }));
  assert.deepEqual(
    specs.map((s) => [s.owner, s.kind, s.label]),
    [
      [WORK_OWNER, "job", "build"],
      [WORK_OWNER, "watch", "make test"],
    ],
  );
  assert.deepEqual(specs[0].data, { jobId: "j1", sessionId: "s1", logPath: "/logs/j1.log" });
});

void test("opening without a host throws, so the caller can stop the job", () => {
  const { items } = setup();
  items.bind(() => undefined, "s1");
  assert.throws(() => items.open(job()), /work host is not available/);
});

void test("a finished job completes its item once; a cancelled one closes without a message", () => {
  const { items, log } = setup();
  items.open(job());
  items.open(job({ id: "j2" }));
  items.finished(job({ status: "succeeded" }));
  items.finished(job({ status: "succeeded" }));
  items.cancel("j2");
  items.cancel("j2");
  assert.deepEqual(log, ["complete item1 done j1", "cancel item2"]);
});

void test("only this session's own live jobs are adopted", () => {
  const { items, handle, log } = setup();
  const data = { jobId: "j1", sessionId: "s1", logPath: "/logs/j1.log" };
  const item = (over: object = {}, id = "x") =>
    handle({ owner: WORK_OWNER, kind: "job", label: "", data: { ...data, ...over } }, id);
  assert.equal(items.adopt(item({ sessionId: "parent" })), false, "records a fork inherited");
  assert.equal(items.adopt(item({ logPath: "/logs/other.log" })), false, "a reused job id");
  assert.equal(items.adopt(item({ jobId: "j9" })), false, "a job this manager does not have");
  assert.equal(items.adopt(handle({ owner: WORK_OWNER, kind: "job", label: "" }, "y")), false);
  assert.equal(items.adopt(item()), true);
  items.finished(job({ status: "succeeded" }));
  assert.deepEqual(log, ["complete x done j1"]);
});

void test("a reload: what ended in the gap is completed through the adopted item, after release", () => {
  const ended = job({ status: "matched" });
  const { items, handle, log } = setup([ended]);
  items.open(job());
  items.suspend();
  items.finished(ended); // the old host is gone: remembered, not delivered
  assert.deepEqual(log, []);

  const fresh = fakeHost();
  items.bind(() => fresh.host, "s1");
  const adopted = handle(
    {
      owner: WORK_OWNER,
      kind: "job",
      label: "",
      data: { jobId: "j1", sessionId: "s1", logPath: "/logs/j1.log" },
    },
    "new",
  );
  assert.equal(items.adopt(adopted), true);
  assert.deepEqual(log, [], "adopting delivers nothing: startup is not over");
  items.release();
  items.release();
  assert.deepEqual(log, ["complete new done j1"]);
});

void test("an adopted item whose job was stopped without a message is closed, not lost", () => {
  const { items, handle, log } = setup([job({ status: "killed" })]);
  const stopped = handle(
    {
      owner: WORK_OWNER,
      kind: "job",
      label: "",
      data: { jobId: "j1", sessionId: "s1", logPath: "/logs/j1.log" },
    },
    "k",
  );
  assert.equal(items.adopt(stopped), true);
  assert.deepEqual(log, ["cancel k"]);
});

void test("after dispose nothing is delivered and the items stay open for the next start", () => {
  const { items, log } = setup();
  items.open(job());
  items.dispose();
  items.finished(job({ status: "succeeded" }));
  assert.deepEqual(log, []);
});
