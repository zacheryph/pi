/** Child activation protocol. Offered before child extensions bind. */
export const ACTIVATION_SERVICE = "subagent:activation:v1";

export interface ActivationRoute {
  /** Register a live pending-work query; unregister on extension shutdown. */
  track(source: () => string | undefined): () => void;
  /** Latch a completion until the manager admits the child's next activation. */
  enqueue(deliver: () => void): void;
  /** Park after the current run, even without outstanding background work. */
  wait(reason: string): void;
}
