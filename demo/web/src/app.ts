/**
 * Demo app shell — login → three panes (admin · chat · wiretap).
 *
 * The chat pane is an agent SWITCHER: one tab per granted account, each a
 * lazily-connected production WebChannelNATSClient lane. A background /me poll
 * reflects live grant/revoke (scene ①) — a granted account grows a new tab, a
 * revoked one loses its tab (and its lane goes terminal on its next
 * register/bootstrap, proven revoke→403). The wiretap observes the whole tenant
 * subtree, so it is account-independent and mounts once. The admin pane renders
 * only for an admin session.
 */
import { api, readConfig, el, type DemoConfig } from "./config.js";
import { createWidget } from "./widget.js";
import { createAdminPanel } from "./admin.js";
import { createWiretap } from "./wiretap.js";

type Rendezvous = { natsUrl: string };
type Me = {
  username: string;
  isAdmin: boolean;
  tenant: string;
  llmMode: "echo" | "real";
  accounts: Record<string, Rendezvous>;
};

const config: DemoConfig = readConfig();

// Teardowns for long-lived panes (admin, wiretap) vs the active chat lane.
const paneTeardowns: (() => void)[] = [];
let laneTeardown: (() => void) | null = null;
let activeAccount: string | null = null;
let grantedAccounts: string[] = [];
let mePollTimer: number | null = null;

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

/** (Re)mount the active chat lane for `accountId`, tearing down the prior one. */
async function mountLane(accountId: string): Promise<void> {
  if (laneTeardown) {
    laneTeardown();
    laneTeardown = null;
  }
  activeAccount = accountId;
  const laneBody = $("chat-lane");
  laneBody.replaceChildren(el("div", { style: "color:var(--muted);font-size:12px" }, ["connecting…"]));
  try {
    laneTeardown = await createWidget(laneBody, config, accountId);
  } catch (err) {
    laneBody.replaceChildren(
      el("div", { style: "color:var(--bad);font-size:12px" }, [`lane failed: ${(err as Error).message}`]),
    );
  }
}

/** Render the account tab bar over the current grant set. */
function renderTabs(): void {
  const tabBar = $("chat-tabs");
  if (grantedAccounts.length === 0) {
    tabBar.replaceChildren(
      el("div", { style: "color:var(--muted);font-size:12px" }, ["No agent granted — ask an admin to grant one."]),
    );
    return;
  }
  tabBar.replaceChildren(
    ...grantedAccounts.map((acct) => {
      const active = acct === activeAccount;
      const tab = el(
        "button",
        {
          style:
            "font-size:12px;padding:5px 12px;border-radius:6px 6px 0 0;" +
            (active
              ? "background:#21262d;border-color:var(--accent);color:var(--fg)"
              : "opacity:.6;border-bottom-color:transparent"),
        },
        [acct],
      );
      tab.onclick = () => {
        if (acct !== activeAccount) {
          renderTabsWithActive(acct);
          void mountLane(acct);
        }
      };
      return tab;
    }),
  );
}
function renderTabsWithActive(acct: string): void {
  activeAccount = acct;
  renderTabs();
}

/**
 * Reconcile the tab set to a fresh grant list. Adds/removes tabs; if the active
 * account was revoked, switches to the first remaining (or clears the lane).
 */
async function reconcileGrants(accounts: string[]): Promise<void> {
  const prev = grantedAccounts.join(",");
  grantedAccounts = accounts;
  if (accounts.join(",") === prev) return; // no change

  if (activeAccount && !accounts.includes(activeAccount)) {
    // Active lane was revoked.
    if (laneTeardown) { laneTeardown(); laneTeardown = null; }
    activeAccount = null;
    $("chat-lane").replaceChildren();
  }
  if (!activeAccount && accounts.length > 0) {
    activeAccount = accounts[0];
    await mountLane(accounts[0]);
  }
  renderTabs();
}

async function mountForSession(me: Me): Promise<void> {
  const appEl = $("app");
  const who = $("whoami");
  who.textContent = `${me.username}${me.isAdmin ? " (admin)" : ""}`;
  who.classList.remove("hidden");
  $("logout").classList.remove("hidden");

  // Chat pane scaffold: a tab bar + a lane container.
  const chatBody = $("chat-body");
  chatBody.replaceChildren(
    el("div", { id: "chat-tabs", style: "display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:10px" }),
    el("div", { id: "chat-lane" }),
  );

  if (me.isAdmin) {
    $("admin-pane").classList.remove("hidden");
    appEl.classList.remove("no-admin");
    paneTeardowns.push(createAdminPanel($("admin-body"), config));
  } else {
    $("admin-pane").classList.add("hidden");
    appEl.classList.add("no-admin");
  }

  // /me carries the live rendezvous (incl. runtime-added accounts, scene ②);
  // merge it into the static page config so widget/wiretap can dial new gateways.
  Object.assign(config.accounts, me.accounts);
  grantedAccounts = Object.keys(me.accounts);
  renderTabs();
  if (grantedAccounts.length > 0) {
    await mountLane(grantedAccounts[0]);
    renderTabs();
  }
  // Wiretap watches the whole tenant subtree via OPERATOR observer creds (minted
  // only behind the admin session — the browser-facing /nats-user cannot mint
  // them). It is account-independent, so mount once — for admins only.
  if (me.isAdmin && grantedAccounts.length > 0) {
    try {
      paneTeardowns.push(await createWiretap($("wiretap-body"), config, grantedAccounts[0]));
    } catch (err) {
      $("wiretap-body").replaceChildren(
        el("div", { style: "color:var(--bad);font-size:12px" }, [`wiretap failed: ${(err as Error).message}`]),
      );
    }
  } else {
    $("wiretap-body").replaceChildren(
      el("div", { style: "color:var(--muted);font-size:12px;line-height:1.5" }, [
        "The wiretap is a tenant-wide observer — an operator capability. Sign in as admin to watch raw relay frames.",
      ]),
    );
  }

  $("login").classList.add("hidden");
  appEl.classList.remove("hidden");

  // Poll /me for live grant/revoke (scene ①).
  mePollTimer = window.setInterval(async () => {
    const res = await api<Me>("/me");
    if (res.ok && res.data.accounts) {
      Object.assign(config.accounts, res.data.accounts); // pick up runtime-added rendezvous
      await reconcileGrants(Object.keys(res.data.accounts));
    }
  }, 3000);
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
    if (mePollTimer !== null) clearInterval(mePollTimer);
    if (laneTeardown) laneTeardown();
    while (paneTeardowns.length) paneTeardowns.pop()?.();
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
