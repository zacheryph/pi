/** Child activation protocol. Offered before child extensions bind. */
export const ACTIVATION_SERVICE = "subagent:activation:v1";

export interface ActivationRoute {
  /** Register a live pending-work query; unregister on extension shutdown. */
  track(source: () => string | undefined): () => void;
  /**
   * Latch a completion until the manager admits the child's next activation.
   * False when the child can no longer be activated (stopped, finished or
   * disposed): the closure is dropped and the caller owns reporting the loss.
   */
  enqueue(deliver: () => void): boolean;
  /** Park after the current run, even without outstanding background work. */
  wait(reason: string): void;
}
