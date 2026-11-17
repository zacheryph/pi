import type { ActionBus } from "#src/actions";
import { isText } from "#src/guards";

// Which connected consumers can answer forms on this session right now. Like
// actions and views, an advertisement is a listener on the session's bus, so
// each session (each subagent too) has its own and nothing is process-global.
// It is capability discovery only: no form state is kept here.

/** The bus channel that carries form-consumer list requests. */
export const FORM_CONSUMERS_CHANNEL = "surface:form-consumers";
/** Emitted after a consumer advertises or revokes: `{ version }`. */
export const FORM_CONSUMERS_CHANGED_EVENT = "surface:form-consumers-changed";
export const FORM_CONSUMERS_VERSION = 1;

export interface FormConsumerInfo {
  /** Who answers, for logs and diagnostics, e.g. `bb` or `dashboard`. */
  name: string;
}

type ConsumerRequest = {
  version: typeof FORM_CONSUMERS_VERSION;
  kind: "list";
  add(info: FormConsumerInfo): void;
};

function announce(bus: ActionBus): void {
  bus.emit(FORM_CONSUMERS_CHANGED_EVENT, { version: FORM_CONSUMERS_VERSION });
}

/**
 * Advertise that a consumer can answer this session's forms. Call it only
 * once its connection is up and its form handler is ready, and never for a
 * saved snapshot or a fixture, which nobody answers. Returns the revoke, to
 * call when the connection closes or the consumer is disposed; it is
 * idempotent, and its announcement is dropped on a bus Pi has retired.
 */
export function advertiseFormConsumer(bus: ActionBus, info: FormConsumerInfo): () => void {
  if (!isText()(info.name)) throw new Error("A form consumer needs a name.");
  const { name } = info;
  const off = bus.on(FORM_CONSUMERS_CHANNEL, (data) => {
    const req = data as ConsumerRequest | null | undefined;
    if (req?.version === FORM_CONSUMERS_VERSION && req.kind === "list") req.add({ name });
  });
  announce(bus);
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    off();
    try {
      announce(bus);
    } catch {
      // A retired bus has no producer left to tell.
    }
  };
}

/** The consumers that can answer forms on this bus now, in advertisement order. */
export function listFormConsumers(bus: ActionBus): FormConsumerInfo[] {
  const found: FormConsumerInfo[] = [];
  bus.emit(FORM_CONSUMERS_CHANNEL, {
    version: FORM_CONSUMERS_VERSION,
    kind: "list",
    add: (info) => found.push(info),
  } satisfies ConsumerRequest);
  return found;
}

/** Whether at least one live consumer can answer forms on this bus now. */
export function hasFormConsumer(bus: ActionBus): boolean {
  return listFormConsumers(bus).length > 0;
}

/**
 * Calls `listener(true)` when the session gains its first form consumer and
 * `listener(false)` when the last one withdraws. A consumer withdrawing while
 * another remains, or a second one arriving, is not a change. The starting
 * state is `hasFormConsumer(bus)` at subscription and is not reported.
 * Returns the unsubscribe.
 */
export function onFormCapabilityChanged(
  bus: ActionBus,
  listener: (available: boolean) => void,
): () => void {
  let available = hasFormConsumer(bus);
  return bus.on(FORM_CONSUMERS_CHANGED_EVENT, (data) => {
    const event = data as { version?: unknown } | null | undefined;
    if (event?.version !== FORM_CONSUMERS_VERSION) return;
    const now = hasFormConsumer(bus);
    if (now === available) return;
    available = now;
    listener(now);
  });
}
