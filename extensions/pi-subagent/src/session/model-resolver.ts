/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback, and
 * "<family>@latest" for the newest available model of a family.
 */
import type { Model } from "@earendil-works/pi-ai";

import { resolveModel, type ModelRegistry as Registry } from "#foundations/models";
export { resolveModel, LATEST_SUFFIX } from "#foundations/models";
export type ModelRegistry = Registry<Model<any>>;

/** Successful model resolution — `model` is the resolved or inherited model instance. */
export interface ModelResolutionResult {
  model: Model<any> | undefined;
  error?: undefined;
}

/** Failed model resolution when the model was user-specified (params) — surface the error. */
export interface ModelResolutionError {
  model?: undefined;
  error: string;
}

/** Discriminated union returned by `resolveInvocationModel`. */
export type ModelResolution = ModelResolutionResult | ModelResolutionError;

/**
 * Resolve the effective model for an agent invocation.
 *
 * Encapsulates the three-branch fallback policy used in `Agent.execute`:
 * 1. No `modelInput` → inherit `parentModel`.
 * 2. `modelInput` resolves → return the resolved model.
 * 3. `modelInput` fails:
 *    - `modelFromParams` true  → return `{ error }` so the caller can surface it.
 *    - `modelFromParams` false → silent fallback to `parentModel`.
 *
 * `modelFromParams` reports which side supplied the winning string, not merely whether
 * the caller passed one — a caller whose value an agent's `locked:` frontmatter discarded
 * did not win, so its typo is not the string being resolved here.
 */
export function resolveInvocationModel(
  parentModel: Model<any> | undefined,
  modelInput: string | undefined,
  modelFromParams: boolean,
  registry: ModelRegistry | undefined,
): ModelResolution {
  if (!modelInput) return { model: parentModel };
  if (!registry) return { error: "No model registry available." };
  const resolved = resolveModel(modelInput, registry);
  if (typeof resolved !== "string") return { model: resolved };
  if (modelFromParams) return { error: resolved };
  return { model: parentModel };
}
