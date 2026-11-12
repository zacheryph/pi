/** Plain error text; consumers sanitize it for their own output boundary. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
