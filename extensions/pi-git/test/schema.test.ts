import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import piGit from "#src/index";

const tools = new Map<string, ToolDefinition>();
piGit({
  registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
  registerCommand: () => {},
  on: () => {},
  events: { on: () => () => {}, emit: () => {} },
} as unknown as ExtensionAPI);

// Validate the serialized schemas sent to providers, not TypeBox's runtime metadata.
const wireSchema = (schema: unknown) => JSON.parse(JSON.stringify(schema));
const ajv = new Ajv2020();

describe("pi-git tool schemas", () => {
  for (const [name, tool] of tools) {
    it(`${name} schemas conform to draft 2020-12`, () => {
      for (const schema of [tool.parameters, tool.outputSchema].filter(Boolean)) {
        expect(ajv.validateSchema(wireSchema(schema)), ajv.errorsText()).toBe(true);
      }
    });
  }

  it("describes git_pr_status's structured result, which job_watch matches on", () => {
    const validate = ajv.compile(wireSchema(tools.get("git_pr_status")!.outputSchema));
    const entry = {
      key: "github.com/acme/api#12",
      label: "acme/api#12",
      url: "https://github.com/acme/api/pull/12",
      checks: { passed: 1, failed: 0, pending: 0 },
      ciDone: true,
      source: "gh",
    };
    expect(validate({ prs: [entry] })).toBe(true);
    expect(validate({ prs: [{ ...entry, error: "gh is not installed", ciDone: false }] })).toBe(
      true,
    );
    expect(validate({ prs: [{ ...entry, ciDone: undefined }] })).toBe(false);
    expect(validate({ prs: [{ ...entry, checks: { passed: 1 } }] })).toBe(false);
  });
});
