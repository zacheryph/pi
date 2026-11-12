// Loaded as an extension by waiting-sdk.test.ts: pi-job with a watch interval short enough for a
// test. A child that loads it gets `job_start` and `job_watch` as a real session would.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobsExtension } from "#job";

export default createJobsExtension({
  logRoot: join(tmpdir(), "pi-subagent-test-jobs"),
  minIntervalSeconds: 0.1,
});
