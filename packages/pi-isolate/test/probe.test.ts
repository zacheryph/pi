import { spawn, spawnSync } from "node:child_process";
import { chmodSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { tempDir, writeFiles } from "#test-helpers";
import { childEnvironment, loadPolicy } from "#src/config";

it.skipIf(process.env.PI_ISOLATE_PROBE !== "1")(
  "enforces filesystem and env restrictions during real Pi extension loading and subprocess execution",
  async ({ onTestFinished }) => {
    const root = realpathSync(tempDir(onTestFinished, "pi-isolate-"));
    writeFiles(root, {
      "host/policy.yaml": {
        version: 1,
        sandbox: {
          allowPty: true,
          network: { allowedDomains: ["example.com"], deniedDomains: [] },
          filesystem: {
            denyRead: [join(root, "denied")],
            allowWrite: [join(root, "project"), join(root, "allowed"), join(root, "agent")],
            denyWrite: [join(root, "denied")],
          },
        },
        env: {
          set: {
            PI_SCRIPTED_MODEL: "1",
            PI_OFFLINE: "1",
            PI_ISOLATE_NETWORK_PROBE: process.env.PI_ISOLATE_NETWORK_PROBE === "1" ? "1" : "0",
            PI_CODING_AGENT_DIR: join(root, "agent"),
            PI_ISOLATE_FIXTURES: root,
            PI_ISOLATE_LITERAL: "$(echo untouched) ' literal",
          },
        },
      },
      "allowed/secret": "control",
      "denied/secret": "denied",
      "project/.keep": "",
      "project/.env": "PI_ISOLATE_HOST_ONLY=dotenv-must-not-load\n",
      "project/bunfig.toml": 'preload = ["./startup.ts"]\n',
      "project/startup.ts": 'process.env.PI_ISOLATE_HOST_ONLY = "bunfig-must-not-load";',
      "agent/settings.json": { packages: [], compaction: { enabled: false } },
    });
    const policy = join(root, "host/policy.yaml");
    chmodSync(policy, 0o600);
    const env = childEnvironment(
      loadPolicy(policy),
      { ...process.env, PI_ISOLATE_HOST_ONLY: "must-not-leak" },
      realpathSync(process.execPath),
    );
    const driver = fileURLToPath(new URL("./fixtures/driver.mjs", import.meta.url));
    const command = process.env.PI_ISOLATE_PROBE_BINARY
      ? [process.env.PI_ISOLATE_PROBE_BINARY]
      : [process.execPath, driver];
    const extension = fileURLToPath(new URL("./fixtures/extension.ts", import.meta.url));
    async function run(args: string[], input = "", rpc = false) {
      const child = spawn(
        command[0],
        [
          ...command.slice(1),
          policy,
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-extensions",
          "-e",
          extension,
          "--provider",
          "pi-scripted",
          "--model",
          "scripted-model",
          "--no-session",
          ...args,
        ],
        { cwd: join(root, "project"), env, stdio: "pipe" },
      );
      onTestFinished(() => {
        child.kill("SIGKILL");
      });
      const out: Buffer[] = [],
        err: Buffer[] = [];
      let pending = "";
      child.stdout.on("data", (data) => {
        out.push(data);
        if (!rpc) return;
        pending += data.toString();
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          const event = JSON.parse(line);
          if (input === "hold" && event.type === "agent_start")
            child.stdin.write(JSON.stringify({ id: "abort", type: "abort" }) + "\n");
          if (event.type === "agent_settled") child.stdin.end();
        }
      });
      child.stderr.on("data", (data) => err.push(data));
      if (rpc)
        child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: input }) + "\n");
      else child.stdin.end(input);
      const result = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve({ code, signal }));
        },
      );
      expect(Buffer.concat(err).toString(), "sandbox stderr").toBe("");
      expect(result).toEqual({ code: 0, signal: null });
      return Buffer.concat(out).toString();
    }
    expect((await run(["--mode", "text", "-p", "probe"])).trim()).toBe("isolation-probe-ok");
    if (process.env.PI_ISOLATE_NETWORK_PROBE === "1") {
      const network = JSON.parse(readFileSync(join(root, "allowed/network.json"), "utf8"));
      expect(network.allowed.status, network.allowed.diagnostic).toBe(0);
      expect(network.allowed.body).toContain("Example Domain");
      expect(network.denied.status).toBe(22);
      expect(network.denied.body).toBe("");
    }
    const report = JSON.parse(readFileSync(join(root, "allowed/report.json"), "utf8"));
    for (const part of [report.top, report.subprocess])
      expect(part).toMatchObject({
        allowedRead: "control",
        allowedWrite: "ok",
        deniedRead: "blocked",
        deniedWrite: "blocked",
        hostOnly: "absent",
        literal: "$(echo untouched) ' literal",
        proxy: true,
        cwd: join(root, "project"),
      });
    expect(readFileSync(join(root, "denied/secret"), "utf8")).toBe("denied");
    const lines = (await run(["--mode", "json", "-p"], "probe from stdin"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      lines.some(
        (line) =>
          line.type === "message_end" &&
          Array.isArray(line.message?.content) &&
          line.message.content.some(
            (content: { text?: string }) => content.text === "isolation-probe-ok",
          ),
      ),
    ).toBe(true);
    for (const prompt of ["probe", "hold"]) {
      const records = (await run(["--mode", "rpc"], prompt, true))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.some((r) => r.type === "response" && r.id === "prompt" && r.success)).toBe(
        true,
      );
      expect(records.some((r) => r.type === "agent_settled")).toBe(true);
      if (prompt === "hold")
        expect(records.some((r) => r.type === "response" && r.id === "abort" && r.success)).toBe(
          true,
        );
    }
    const tty = spawnSync(
      "python3",
      [fileURLToPath(new URL("./fixtures/probe_terminal.py", import.meta.url))],
      {
        input: JSON.stringify({
          argv: [
            ...command,
            policy,
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-extensions",
            "-e",
            extension,
            "--provider",
            "pi-scripted",
            "--model",
            "scripted-model",
            "--no-session",
          ],
          cwd: join(root, "project"),
          env: { ...env, TERM: "xterm-256color" },
        }),
        encoding: "utf8",
        timeout: 25_000,
      },
    );
    expect(tty.stderr).toBe("");
    expect(tty.status).toBe(0);
    expect(JSON.parse(tty.stdout)).toEqual({
      prompt: true,
      resize: true,
      eof: true,
      terminalRestored: true,
    });
  },
  60_000,
);
