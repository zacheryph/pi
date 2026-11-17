import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { tempDir, writeFiles } from "#test-helpers";
import { childEnvironment, loadPolicy, preparePolicy } from "#src/config";

function fixture(cleanup: (fn: () => void) => void) {
  const root = realpathSync(tempDir(cleanup));
  writeFiles(root, {
    "host/isolation.yaml": {
      version: 1,
      sandbox: {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: ["."], denyWrite: [] },
      },
      env: { pass: ["KEEP", "MISSING"], set: { VALUE: "$(echo secret) ' literal" } },
    },
    "project/control": "ok",
    "install/control": "trusted",
  });
  const path = join(root, "host/isolation.yaml");
  chmodSync(path, 0o600);
  return { root, path, cwd: join(root, "project"), install: join(root, "install") };
}

describe("launch policy", () => {
  it("filters the host env and preserves literal overrides", ({ onTestFinished }) => {
    const { path } = fixture(onTestFinished);
    const env = childEnvironment(
      loadPolicy(path),
      {
        KEEP: "pass",
        HOST_ONLY: "secret",
        NODE_OPTIONS: "--import evil",
        HTTPS_PROXY: "evil",
        HOME: "evil",
        PATH: ".",
      },
      "/trusted/bin/node",
      "/real/home",
    );
    expect(env).toMatchObject({
      HOME: "/real/home",
      KEEP: "pass",
      VALUE: "$(echo secret) ' literal",
      TMPDIR: "/tmp",
    });
    for (const key of ["MISSING", "HOST_ONLY", "NODE_OPTIONS", "HTTPS_PROXY"])
      expect(env).not.toHaveProperty(key);
    expect(env.PATH!.split(":")).not.toContain(".");
  });
  it.each([
    "NODE_OPTIONS",
    "BASH_ENV",
    "ENV",
    "DYLD_INSERT_LIBRARIES",
    "HTTP_PROXY",
    "PATH",
    "HOME",
    "SRT_DEBUG",
    "GIT_CONFIG_COUNT",
    "PYTHONPATH",
    "RIPGREP_CONFIG_PATH",
    "OPENSSL_CONF",
  ])("reserves %s", (name) => {
    const { path } = fixture(onTestFinished);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sandbox: {
          network: { allowedDomains: [], deniedDomains: [] },
          filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
        },
        env: { set: { [name]: "secret-value" } },
      }),
    );
    expect(() => loadPolicy(path)).toThrow("reserved variable");
    expect(() => loadPolicy(path)).not.toThrow("secret-value");
  });
  it.each([
    "version: 1\nversion: 2",
    "version: 2",
    "version: 1\nsandbox: &a [*a]",
    "secret-value: whatever",
    "[invalid",
    "version: 1\nenv: { set: { SECRET: 123 } }",
  ])("rejects malformed input without echoing it", (source) => {
    const { path } = fixture(onTestFinished);
    writeFileSync(path, source);
    expect(() => loadPolicy(path)).toThrow(path);
    try {
      loadPolicy(path);
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
  it("rejects unknown keys at every supported level and unsafe values", ({ onTestFinished }) => {
    const { path } = fixture(onTestFinished);
    const valid = loadPolicy(path);
    for (const value of [
      { ...valid, extra: true },
      { ...valid, sandbox: { ...valid.sandbox, enableWeakerNestedSandbox: true } },
      {
        ...valid,
        sandbox: { ...valid.sandbox, filesystem: { ...valid.sandbox.filesystem, disabled: true } },
      },
      {
        ...valid,
        sandbox: { ...valid.sandbox, network: { ...valid.sandbox.network, httpProxyPort: 8080 } },
      },
      { ...valid, env: { pass: ["*"] } },
      {
        ...valid,
        sandbox: {
          ...valid.sandbox,
          filesystem: { ...valid.sandbox.filesystem, allowWrite: ["**"] },
        },
      },
    ]) {
      writeFileSync(path, JSON.stringify(value));
      expect(() => loadPolicy(path)).toThrow();
    }
  });
  it("resolves paths against cwd and protects the trusted installation", ({ onTestFinished }) => {
    const f = fixture(onTestFinished);
    const policy = loadPolicy(f.path);
    policy.sandbox.filesystem.denyRead = ["../private/new-file"];
    const effective = preparePolicy(policy, f.path, f.cwd, [f.install]);
    expect(effective.filesystem.allowWrite).toEqual([f.cwd]);
    expect(effective.filesystem.denyRead).toEqual([join(f.root, "private/new-file")]);
    expect(effective.network.strictAllowlist).toBe(true);
    for (const grant of [
      f.root,
      join(f.root, "host"),
      f.install,
      join(f.install, "node_modules/dependency"),
      "/",
    ]) {
      policy.sandbox.filesystem.allowWrite = [grant];
      expect(() => preparePolicy(policy, f.path, f.cwd, [f.install])).toThrow("overlaps");
    }
  });
  it("rejects symlinked grants and follows policy symlinks for protection", ({
    onTestFinished,
  }) => {
    const f = fixture(onTestFinished);
    symlinkSync(f.install, join(f.cwd, "alias"));
    const policy = loadPolicy(f.path);
    policy.sandbox.filesystem.allowWrite = [join(f.cwd, "alias")];
    expect(() => preparePolicy(policy, f.path, f.cwd, [f.install])).toThrow();
    mkdirSync(join(f.root, "other"));
    symlinkSync(f.path, join(f.root, "other/policy"));
    policy.sandbox.filesystem.allowWrite = [join(f.root, "host")];
    expect(() => preparePolicy(policy, join(f.root, "other/policy"), f.cwd, [])).toThrow(
      "overlaps",
    );
  });
  it("rejects group-writable policy files and missing policies", ({ onTestFinished }) => {
    const f = fixture(onTestFinished);
    chmodSync(f.path, 0o660);
    expect(() => preparePolicy(loadPolicy(f.path), f.path, f.cwd, [])).toThrow("user-owned");
    expect(() => loadPolicy(join(f.root, "missing"))).toThrow("cannot read");
  });
});
