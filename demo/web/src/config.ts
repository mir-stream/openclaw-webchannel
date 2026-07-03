/**
 * Demo runtime config — injected by saas-server.ts into the page <head> as
 * `globalThis.__DEMO_CONFIG__` before /app.js runs. The browser never learns the
 * relay/gateway from anything but this SaaS-delivered config (SaaS = rendezvous
 * authority): per-account `{ natsUrl, registerBaseUrl }` travels with the account.
 */
export type RendezvousEntry = { natsUrl: string; registerBaseUrl: string };

export type DemoConfig = {
  issuerUrl: string;
  tenant: string;
  accounts: Record<string, RendezvousEntry>;
  llmMode: "echo" | "real";
};

export function readConfig(): DemoConfig {
  const c = (globalThis as unknown as { __DEMO_CONFIG__?: DemoConfig }).__DEMO_CONFIG__;
  if (!c) throw new Error("__DEMO_CONFIG__ missing — saas-server did not inject it");
  return c;
}

/** base64url-encode raw bytes (browser-safe; no Buffer). */
export function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Same-origin JSON fetch that always carries the session cookie. */
export async function api<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Minimal DOM builder: el("div", {class:"x"}, [children|string]). */
export function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}
