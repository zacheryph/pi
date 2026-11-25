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
  private text = "";

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this.text;
  }
  set textContent(value: string) {
    this.children = [];
    this.text = String(value);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  get firstElementChild(): FakeNode | undefined {
    return this.children[0];
  }
  get lastElementChild(): FakeNode | undefined {
    return this.children.at(-1);
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
  location: { hash: string };
  /** Delivers a `sessions` event, as the hub's /events stream does, and lets the page render it. */
  sessions(data: unknown): void;
  /** Calls one of the script's top-level functions. */
  call(name: string, ...args: unknown[]): unknown;
}

/** Runs the page's inline script against the fake DOM, with no sessions yet. */
export function runPage(page: string): PageRun {
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
    setInterval: () => 0,
    setTimeout: () => 0,
    fetch: () => new Promise(() => {}),
  });
  new Script(script).runInContext(context);
  return {
    main: named("main"),
    location,
    sessions: (data) => listeners.get("sessions")!({ data: JSON.stringify(data) }),
    call: (name, ...args) => (context[name] as (...args: unknown[]) => unknown)(...args),
  };
}
