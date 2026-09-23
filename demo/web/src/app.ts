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
let laneOwner: AbortController | null = null;
let sessionOwner = new AbortController();

function ownsSession(owner: AbortController): boolean {
  return sessionOwner === owner && !owner.signal.aborted;
}

function clearLane(): void {
  laneOwner?.abort();
  laneOwner = null;
  laneTeardown?.();
  laneTeardown = null;
  activeAccount = null;
}

/** Retire pending mounts as well as panes whose teardown is already available. */
function resetSession(): AbortController {
  sessionOwner.abort();
  if (mePollTimer !== null) window.clearInterval(mePollTimer);
  mePollTimer = null;
  clearLane();
  while (paneTeardowns.length) paneTeardowns.pop()?.();
  grantedAccounts = [];
  sessionOwner = new AbortController();
  return sessionOwner;
}

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
  clearLane();
  const owner = new AbortController();
  laneOwner = owner;
  activeAccount = accountId;
  const laneBody = $("chat-lane");
  const mount = el("div");
  laneBody.replaceChildren(mount);
  try {
    const teardown = await createWidget(mount, config, accountId, owner.signal);
    if (laneOwner !== owner || owner.signal.aborted) {
      teardown();
      return;
    }
    laneTeardown = teardown;
  } catch (err) {
    if (laneOwner !== owner || owner.signal.aborted) return;
    mount.replaceChildren(
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
async function reconcileGrants(accounts: string[], owner: AbortController): Promise<void> {
  if (!ownsSession(owner)) return;
  const prev = grantedAccounts.join(",");
  grantedAccounts = accounts;
  if (accounts.join(",") === prev) return; // no change

  if (activeAccount && !accounts.includes(activeAccount)) {
    // Active lane was revoked.
    clearLane();
    $("chat-lane").replaceChildren();
  }
  if (!activeAccount && accounts.length > 0) {
    activeAccount = accounts[0];
    await mountLane(accounts[0]);
    if (!ownsSession(owner)) return;
  }
  renderTabs();
}

async function mountForSession(me: Me, owner: AbortController): Promise<void> {
  if (!ownsSession(owner)) return;
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
  $("login").classList.add("hidden");
  appEl.classList.remove("hidden");

  // One poll at a time; responses from a retired login cannot restore grants.
  let polling = false;
  mePollTimer = window.setInterval(async () => {
    if (polling || !ownsSession(owner)) return;
    polling = true;
    try {
      const res = await api<Me>("/me", { signal: owner.signal });
      if (!ownsSession(owner)) return;
      if (res.ok && res.data.accounts) {
        Object.assign(config.accounts, res.data.accounts);
        await reconcileGrants(Object.keys(res.data.accounts), owner);
      }
    } catch {
      // A later poll can recover a network error; cancellation retires this poll.
    } finally {
      polling = false;
    }
  }, 3000);

  if (grantedAccounts.length > 0) {
    await mountLane(grantedAccounts[0]);
    if (!ownsSession(owner)) return;
    renderTabs();
  }
  // Wiretap watches the whole tenant subtree via OPERATOR observer creds (minted
  // only behind the admin session — the browser-facing /nats-user cannot mint
  // them). It is account-independent, so mount once — for admins only.
  if (me.isAdmin && grantedAccounts.length > 0) {
    try {
      const teardown = await createWiretap($("wiretap-body"), config, grantedAccounts[0], owner.signal);
      if (!ownsSession(owner)) {
        teardown();
        return;
      }
      paneTeardowns.push(teardown);
    } catch (err) {
      if (!ownsSession(owner)) return;
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
}

async function tryResumeSession(): Promise<void> {
  const owner = sessionOwner;
  try {
    const { ok, data } = await api<Me>("/me", { signal: owner.signal });
    if (ownsSession(owner) && ok && data.username) await mountForSession(data, owner);
  } catch {
    // Leave the sign-in screen available when session lookup cannot complete.
  }
}

function wireLogin(): void {
  const btn = $("login-btn") as HTMLButtonElement;
  const err = $("login-err");
  const doLogin = async () => {
    if (btn.disabled) return;
    const owner = resetSession();
    err.textContent = "";
    btn.disabled = true;
    const username = ($("username") as HTMLInputElement).value.trim();
    const password = ($("password") as HTMLInputElement).value;
    try {
      const res = await api<{ ok?: boolean; error?: string }>("/login", {
        method: "POST",
        body: { username, password },
        signal: owner.signal,
      });
      if (!ownsSession(owner)) return;
      if (!res.ok || !res.data.ok) {
        err.textContent = res.data.error ?? "login failed";
        return;
      }
      const me = await api<Me>("/me", { signal: owner.signal });
      if (ownsSession(owner) && me.ok) await mountForSession(me.data, owner);
    } catch (error) {
      if (ownsSession(owner)) err.textContent = error instanceof Error ? error.message : "login failed";
    } finally {
      if (ownsSession(owner)) btn.disabled = false;
    }
  };
  btn.onclick = doLogin;
  ($("password") as HTMLInputElement).onkeydown = (e) => {
    if ((e as KeyboardEvent).key === "Enter") doLogin();
  };
}

function wireLogout(): void {
  const logout = $("logout") as HTMLButtonElement;
  let loggingOut = false;
  logout.onclick = async () => {
    if (loggingOut) return;
    loggingOut = true;
    const owner = resetSession();
    logout.disabled = true;
    logout.textContent = "Signing out…";
    const login = $("login-btn") as HTMLButtonElement;
    login.disabled = true;
    $("login").classList.add("hidden");
    $("app").classList.add("hidden");
    $("whoami").classList.add("hidden");
    $("whoami").textContent = "";
    for (const id of ["chat-body", "admin-body", "wiretap-body"]) $(id).replaceChildren();
    ($("password") as HTMLInputElement).value = "";
    try {
      const res = await api("/logout", { method: "POST", signal: owner.signal });
      if (!ownsSession(owner)) return;
      // A lost prior response or an already-expired sid is also signed out.
      if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
      $("login-err").textContent = "";
      $("login").classList.remove("hidden");
      logout.classList.add("hidden");
      logout.textContent = "Log out";
      login.disabled = false;
    } catch {
      if (!ownsSession(owner)) return;
      $("login").classList.remove("hidden");
      $("login-err").textContent = "Log out failed. Your server session may still be active. Try Log out again.";
      logout.textContent = "Retry log out";
      // Keep login disabled until logout settles so its cookie expiry cannot
      // race a new login's Set-Cookie response.
    } finally {
      loggingOut = false;
      if (ownsSession(owner)) logout.disabled = false;
    }
  };
}

function boot(): void {
  renderLlmBadge();
  wireLogin();
  wireLogout();
  window.addEventListener("pagehide", () => { resetSession(); }, { once: true });
  void tryResumeSession();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

export {}; // module marker (esbuild --global-name needs an export object)
