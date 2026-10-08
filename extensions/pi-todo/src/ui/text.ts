/**
 * Sanitizer adapted from repository-local pi-subagents/src/ui/read-only-browser.ts
 * (itself adapted from pi-system-insights/src/viewer.ts). Own standalone copy.
 * MIT License — Copyright (c) 2026 tintinweb
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
export function sanitizeTodoText(text: string): string {
  return text
    .replace(/\r\n|[\u2028\u2029]/g, "\n")
    .replace(/(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\t/g, "    ");
}

/** User-controlled single physical row, including Unicode line separators. */
export function safeTodoLine(text: string): string {
  return sanitizeTodoText(text).replace(/[\n\u2028\u2029]/g, " ");
}
