import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { fakePi } from "../../../packages/pi-test-helpers/src/fake-pi.ts";
import stashExtension from "#src/index";

const { api, tools } = fakePi();
stashExtension(api);

// Validate the serialized schemas sent to providers, not TypeBox's runtime metadata.
const wireSchema = (schema: unknown) => JSON.parse(JSON.stringify(schema));
const ajv = new Ajv2020();

describe("stash tool schemas", () => {
  for (const [name, tool] of tools) {
    it(`${name} input and output schemas conform to draft 2020-12`, () => {
      for (const schema of [tool.parameters, tool.outputSchema]) {
        expect(schema).toBeDefined();
        expect(ajv.validateSchema(wireSchema(schema)), ajv.errorsText()).toBe(true);
      }
    });
  }

  it("accepts exactly two positive integer line numbers", () => {
    const validate = ajv.compile(wireSchema(tools.get("stash_get")!.parameters));
    expect(validate({ ref: "entry" })).toBe(true);
    expect(validate({ ref: "entry", lines: [1, 2] })).toBe(true);
    expect(validate({ ref: "entry", lines: [2, 2] })).toBe(true);
    for (const lines of [[], [1], [1, 2, 3], [0, 2], [-1, 2], [1, 2.5], ["1", 2], null]) {
      expect(validate({ ref: "entry", lines }), JSON.stringify(lines)).toBe(false);
    }
  });

  it("keeps output ranges as exactly two integers", () => {
    const schema = wireSchema(tools.get("stash_get")!.outputSchema);
    for (const key of ["range", "next"]) {
      const validate = ajv.compile(schema.properties[key]);
      expect(validate([1, 2])).toBe(true);
      for (const range of [[], [1], [1, 2, 3], [1, 2.5], ["1", 2]]) {
        expect(validate(range), `${key}: ${JSON.stringify(range)}`).toBe(false);
      }
    }
  });
});
