/** Structural types keep model lookup independent of the Pi SDK. */
export interface ModelLike {
  provider: string;
  id: string;
  name: string;
}
export interface ModelRegistry<M extends ModelLike> {
  find(provider: string, modelId: string): M | undefined;
  getAll(): M[];
  getAvailable?(): M[];
}

/** Exact, case-insensitive matching only; preserves catalog order and model identity. */
export function findExactModel<M extends ModelLike>(
  models: readonly M[],
  input: string,
): M | undefined {
  const query = input.toLowerCase();
  return models.find(
    (model) =>
      (input.includes("/") ? `${model.provider}/${model.id}` : model.id).toLowerCase() === query,
  );
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 */
export function resolveModel<M extends ModelLike>(
  input: string,
  registry: ModelRegistry<M>,
): M | string {
  // Available models (those with auth configured)
  const all = registry.getAvailable?.() ?? registry.getAll();

  // 0. "[provider/]family@latest": the newest available model of that family.
  if (input.toLowerCase().endsWith(LATEST_SUFFIX)) {
    return resolveLatest(input.slice(0, -LATEST_SUFFIX.length), all, registry);
  }
  const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()));

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const provider = input.slice(0, slashIdx);
    const modelId = input.slice(slashIdx + 1);
    if (availableSet.has(input.toLowerCase())) {
      const found = registry.find(provider, modelId);
      if (found) return found;
    }
  }

  // 2. Fuzzy match against available models
  const bestMatch = findBestFuzzyMatch(all, input.toLowerCase());
  if (bestMatch) {
    const found = registry.find(bestMatch.provider, bestMatch.id);
    if (found) return found;
  }

  // 3. No match — list available models
  const modelList = all
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`;
}

/** Suffix selecting the newest available model of a family, e.g. "anthropic/claude-haiku@latest". */
export const LATEST_SUFFIX = "@latest";

/**
 * Newest available model whose id contains `family` (and whose provider matches,
 * when one is given). Newest compares the numbers in the id left to right, so
 * `claude-haiku-5-5` beats `claude-haiku-4-5-20251001`; no version format is assumed.
 */
function resolveLatest<M extends ModelLike>(
  spec: string,
  all: M[],
  registry: ModelRegistry<M>,
): M | string {
  const slashIdx = spec.indexOf("/");
  const provider = slashIdx === -1 ? undefined : spec.slice(0, slashIdx).toLowerCase();
  const family = spec.slice(slashIdx + 1).toLowerCase();
  const candidates = family
    ? all.filter(
        (m) =>
          (!provider || m.provider.toLowerCase() === provider) &&
          m.id.toLowerCase().includes(family),
      )
    : [];
  const newest = candidates.sort(compareNewestFirst)[0];
  if (newest) return registry.find(newest.provider, newest.id) ?? newest;
  const modelList = all
    .map((m) => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return `No available model matches "${spec}${LATEST_SUFFIX}".\n\nAvailable models:\n${modelList}`;
}

/** Order by the numbers in each id, highest first; ties fall back to the id, descending. */
export function compareNewestFirst(a: Pick<ModelLike, "id">, b: Pick<ModelLike, "id">): number {
  const version = (m: Pick<ModelLike, "id">) =>
    [...m.id.matchAll(/\d+/g)].map((part) => Number(part[0]));
  const av = version(a);
  const bv = version(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const delta = (bv[i] ?? 0) - (av[i] ?? 0);
    if (delta) return delta;
  }
  return b.id.localeCompare(a.id);
}

/**
 * Score each candidate model — prefer exact id match > id contains > name
 * contains > provider+id contains — and return the best match at or above
 * the acceptance threshold (20), or undefined if nothing scores high enough.
 */
function findBestFuzzyMatch<M extends ModelLike>(all: M[], query: string): M | undefined {
  let bestMatch: M | undefined;
  let bestScore = 0;

  for (const m of all) {
    const id = m.id.toLowerCase();
    const name = m.name.toLowerCase();
    const full = `${m.provider}/${m.id}`.toLowerCase();

    let score = 0;
    if (id === query || full === query) {
      score = 100; // exact
    } else if (id.includes(query) || full.includes(query)) {
      score = 60 + (query.length / id.length) * 30; // substring, prefer tighter matches
    } else if (name.includes(query)) {
      score = 40 + (query.length / name.length) * 20;
    } else if (
      query
        .split(/[\s\-/]+/)
        .every(
          (part) =>
            id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part),
        )
    ) {
      score = 20; // all parts present somewhere
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = m;
    }
  }

  return bestScore >= 20 ? bestMatch : undefined;
}
