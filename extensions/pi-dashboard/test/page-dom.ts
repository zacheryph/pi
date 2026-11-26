// A minimal DOM for running the dashboard page's inline script in a VM: enough
// for its renderers to build nodes whose text and classes a test can read.
// Anything the renderers touch that this does not model is a permissive no-op.
import { createContext, Script } from "node:vm";

/** A callable, constructible stand-in for any browser API this file does not model. */
const anything: unknown = new Proxy(function () {}, {
  get: (_target, prop) => (prop === Symbol.toPrimitive ? () => "" : anything),
  apply: () => anything,
  construct: () => anything as object,
  set: () => true,
});

export class FakeNode {
  parent: FakeNode | undefined;
  children: FakeNode[] = [];
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  /** Form state the answer form reads, as a fresh input or textarea has it. */
  value = "";
  checked = false;
  private text = "";
  private listeners = new Map<string, ((event: unknown) => unknown)[]>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    if (this.tagName === "#text") return this.text;
    return this.children.map((child) => child.textContent).join("");
  }
  /** As in a browser: an element's text becomes one text node, which later children follow. */
  set textContent(value: string) {
    if (this.tagName === "#text") {
      this.text = String(value);
      return;
    }
    this.children = [];
    if (String(value)) this.append(String(value));
  }
  private get elements(): FakeNode[] {
    return this.children.filter((child) => child.tagName !== "#text");
  }
  get childElementCount(): number {
    return this.elements.length;
  }
  get firstElementChild(): FakeNode | undefined {
    return this.elements[0];
  }
  get lastElementChild(): FakeNode | undefined {
    return this.elements.at(-1);
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? textNode(node) : node;
      child.parent?.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = this;
      this.children.push(child);
    }
  }
  appendChild(node: FakeNode): FakeNode {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes: FakeNode[]): void {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
  addEventListener(type: string, listener: (event: unknown) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  /** Runs this node's own listeners for `type`, as a user action would; nothing bubbles. */
  dispatch(type: string): void {
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  /** Every descendant, depth first. */
  descendants(): FakeNode[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  /** The text of every descendant whose class list has `name`, in document order. */
  textsOf(name: string): string[] {
    return this.descendants()
      .filter((node) => node.className.split(/\s+/).includes(name))
      .map((node) => node.textContent);
  }
}

/** A node that answers every property it does not model with a no-op. */
function proxied(node: FakeNode): FakeNode {
  return new Proxy(node, {
    get: (target, prop, receiver) =>
      prop in target ? Reflect.get(target, prop, receiver) : anything,
  });
}

function textNode(text: string): FakeNode {
  const node = proxied(new FakeNode("#text"));
  node.textContent = text;
  return node;
}

export interface PageRun {
  /** `<main>`, where the page renders the index or a session's detail. */
  main: FakeNode;
  /** An element the page finds by id, such as the `answer` dialog. */
  byId(id: string): FakeNode;
  location: { hash: string };
  /** Delivers a `sessions` event, as the hub's /events stream does, and lets the page render it. */
  sessions(data: unknown): void;
  /** Calls one of the script's top-level functions. */
  call(name: string, ...args: unknown[]): unknown;
}

/** A request the page made, its body parsed. */
export interface PageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Runs the page's inline script against the fake DOM, with no sessions yet.
 * Requests go to `respond`; without it they never answer.
 */
export function runPage(
  page: string,
  respond?: (request: PageRequest) => { status: number; body: unknown },
): PageRun {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const nodes = new Map<string, FakeNode>();
  const named = (key: string) => {
    if (!nodes.has(key)) nodes.set(key, proxied(new FakeNode(key)));
    return nodes.get(key)!;
  };
  const listeners = new Map<string, (event: { data: string }) => void>();
  class EventSource {
    addEventListener(type: string, listener: (event: { data: string }) => void) {
      listeners.set(type, listener);
    }
  }
  const location = { hash: "" };
  const context = createContext({
    document: {
      title: "",
      activeElement: null,
      querySelector: (selector: string) =>
        selector.startsWith("meta") ? { content: "token" } : named(selector),
      getElementById: (id: string) => named(`#${id}`),
      createElement: (tag: string) => proxied(new FakeNode(tag)),
      createTextNode: (text: string) => textNode(text),
      hasFocus: () => true,
    },
    window: { addEventListener() {}, scrollTo() {} },
    location,
    localStorage: { getItem: () => null, setItem() {} },
    EventSource,
    URL,
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      if (!respond) return new Promise(() => {});
      const { status, body } = respond({
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      });
      return Promise.resolve({ status, json: () => Promise.resolve(body) });
    },
  });
  new Script(script).runInContext(context);
  return {
    main: named("main"),
    byId: (id) => named(`#${id}`),
    location,
    sessions: (data) => listeners.get("sessions")!({ data: JSON.stringify(data) }),
    call: (name, ...args) => (context[name] as (...args: unknown[]) => unknown)(...args),
  };
}
