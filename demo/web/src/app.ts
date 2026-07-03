/**
 * Demo app shell — login → three panes (admin · chat · wiretap).
 *
 * The admin pane renders only for an admin session; alice/bob get chat + wiretap
 * on their granted account. Everything downstream is production: the widget and
 * wiretap drive the real client against the SaaS-delivered rendezvous.
 */
import { api, readConfig, el, type DemoConfig } from "./config.js";
import { createWidget } from "./widget.js";
import { createAdminPanel } from "./admin.js";
import { createWiretap } from "./wiretap.js";

type Me = {
  username: string;
  isAdmin: boolean;
  tenant: string;
  llmMode: "echo" | "real";
  accounts: Record<string, { natsUrl: string; registerBaseUrl: string }>;
};

const config: DemoConfig = readConfig();
const teardowns: (() => void)[] = [];

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node;
}

function renderLlmBadge(): void {
  const badge = $("llm-badge");
  if (config.llmMode === "echo") {
    badge.className = "badge echo";
    badge.textContent = "⚠ Echo mode — no real model";
  } else {
    badge.className = "badge real";
    badge.textContent = "● Real model";
  }
}

async function teardownAll(): Promise<void> {
  while (teardowns.length) teardowns.pop()?.();
}

async function mountForSession(me: Me): Promise<void> {
  const appEl = $("app");
  const adminPane = $("admin-pane");

  // Whoami + logout.
  const who = $("whoami");
  who.textContent = `${me.username}${me.isAdmin ? " (admin)" : ""}`;
  who.classList.remove("hidden");
  $("logout").classList.remove("hidden");

  // The chat/wiretap lane uses the session's first granted account. (Phase 2
  // turns this into a switcher across the granted fleet.)
  const accountId = Object.keys(me.accounts)[0];

  if (me.isAdmin) {
    adminPane.classList.remove("hidden");
    appEl.classList.remove("no-admin");
    teardowns.push(createAdminPanel($("admin-body"), config));
  } else {
    adminPane.classList.add("hidden");
    appEl.classList.add("no-admin");
  }

  if (accountId) {
    try {
      teardowns.push(await createWidget($("chat-body"), config, accountId));
    } catch (err) {
      $("chat-body").replaceChildren(
        el("div", { style: "color:var(--bad);font-size:12px" }, [`widget failed: ${(err as Error).message}`]),
      );
    }
    try {
      teardowns.push(await createWiretap($("wiretap-body"), config, accountId));
    } catch (err) {
      $("wiretap-body").replaceChildren(
        el("div", { style: "color:var(--bad);font-size:12px" }, [`wiretap failed: ${(err as Error).message}`]),
      );
    }
  } else {
    $("chat-body").replaceChildren(
      el("div", { style: "color:var(--muted);font-size:12px" }, ["No agent granted to this login yet — ask an admin to grant one."]),
    );
  }

  $("login").classList.add("hidden");
  appEl.classList.remove("hidden");
}

async function tryResumeSession(): Promise<void> {
  const { ok, data } = await api<Me>("/me");
  if (ok && data.username) await mountForSession(data);
}

function wireLogin(): void {
  const btn = $("login-btn") as HTMLButtonElement;
  const err = $("login-err");
  const doLogin = async () => {
    err.textContent = "";
    btn.disabled = true;
    const username = ($("username") as HTMLInputElement).value.trim();
    const password = ($("password") as HTMLInputElement).value;
    const res = await api<{ ok?: boolean; error?: string }>("/login", {
      method: "POST",
      body: { username, password },
    });
    btn.disabled = false;
    if (!res.ok || !res.data.ok) {
      err.textContent = res.data.error ?? "login failed";
      return;
    }
    const me = await api<Me>("/me");
    if (me.ok) await mountForSession(me.data);
  };
  btn.onclick = doLogin;
  ($("password") as HTMLInputElement).onkeydown = (e) => {
    if ((e as KeyboardEvent).key === "Enter") doLogin();
  };
}

function wireLogout(): void {
  $("logout").onclick = async () => {
    await teardownAll();
    location.reload();
  };
}

function boot(): void {
  renderLlmBadge();
  wireLogin();
  wireLogout();
  void tryResumeSession();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export {}; // module marker (esbuild --global-name needs an export object)
