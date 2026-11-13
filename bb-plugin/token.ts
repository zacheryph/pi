import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Generates the plugin's signing secret once; it lives in the plugin's kv storage. */
export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * The credential a thread's Pi session presents: an HMAC of the thread id, so
 * one token speaks for one thread and the plugin stores nothing per thread.
 */
export function threadToken(secret: string, threadId: string): string {
  return createHmac("sha256", secret).update(`pi-surface:${threadId}`).digest("base64url");
}

export function verifyThreadToken(secret: string, threadId: string, token: string): boolean {
  const expected = Buffer.from(threadToken(secret, threadId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
