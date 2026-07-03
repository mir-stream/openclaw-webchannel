/**
 * Admin panel — the SaaS-as-authority surface (admin session only).
 *
 *  - Enrollment requests: live list with Approve / Deny (scene ②'s "authority
 *    can say no"), plus the terminal states (approved / denied / expired).
 *  - Agent directory: EVERY account the SaaS knows — boot-seeded, admin-added,
 *    and (crucially) accounts that entered via an APPROVED ENROLLMENT. Register
 *    admission rides NATS (no gateway URL to set), so an account in the directory
 *    is immediately grantable — approve an enrollment and it just works.
 *  - User↔account grants: per-user account chips the operator toggles; the
 *    change takes effect at the user's next bootstrap (canAccess at JWT-mint).
 *
 * All calls hit /admin/* which the server gates on an admin session.
 */
import { api, el, type DemoConfig } from "./config.js";

type Enroll = {
  userCode: string;
  tenant?: string;
  accountId?: string;
  status: "pending" | "approved" | "denied" | "expired";
};
type UserRow = { username: string; allowedAccounts: string[] };
type UsersResponse = { accounts: string[]; users: UserRow[] };
type AccountRow = {
  accountId: string;
  source: "boot" | "enrolled" | "admin";
};

const STATUS_COLOR: Record<Enroll["status"], string> = {
  pending: "var(--warn)",
  approved: "var(--good)",
  denied: "var(--bad)",
  expired: "var(--muted)",
};

export function createAdminPanel(bodyEl: HTMLElement, _config: DemoConfig): () => void {
  bodyEl.replaceChildren();

  // ── Signing-key rotation (SaaS-as-authority; Phase 5 aside) ───────────────
  const signingSection = el("div", { style: "margin-bottom:18px" });
  const kidLine = el("div", { style: "font-size:11px;color:var(--muted);margin-bottom:6px;word-break:break-all" });
  const rotateBtn = el("button", { class: "primary", style: "font-size:11px;padding:3px 10px" }, ["Rotate key"]) as HTMLButtonElement;
  const evictBtn = el("button", { style: "font-size:11px;padding:3px 10px;margin-left:6px;border-color:var(--bad)" }, ["Rotate + evict old"]) as HTMLButtonElement;
  signingSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["Signing key (JWKS)"]),
    kidLine,
    el("div", {}, [rotateBtn, evictBtn]),
  );

  async function refreshSigningKey(): Promise<void> {
    const { ok, data } = await api<{ activeKid: string; jwksKids: string[] }>("/admin/signing-key");
    if (!ok || !data?.activeKid) return;
    const short = (k: string) => k.slice(0, 8);
    kidLine.replaceChildren(
      el("span", {}, [`active kid `]),
      el("code", { style: "color:var(--good)" }, [short(data.activeKid)]),
      el("span", {}, [`  ·  JWKS: ${data.jwksKids.map(short).join(", ")}`]),
    );
  }
  const rotate = (evictPrevious: boolean) => async () => {
    rotateBtn.disabled = evictBtn.disabled = true;
    await api("/admin/rotate-key", { method: "POST", body: { evictPrevious } });
    await refreshSigningKey();
    rotateBtn.disabled = evictBtn.disabled = false;
  };
  rotateBtn.onclick = rotate(false);
  evictBtn.onclick = rotate(true);

  const enrollSection = el("div", { style: "margin-bottom:18px" });
  const enrollList = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  enrollSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["Enrollment requests"]),
    enrollList,
  );

  const acctSection = el("div", { style: "margin-bottom:18px" });
  const acctList = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  acctSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["Agent directory"]),
    acctList,
  );

  const usersSection = el("div");
  const usersList = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
  usersSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["User → agent grants"]),
    usersList,
  );

  bodyEl.append(signingSection, enrollSection, acctSection, usersSection);

  async function refreshEnrollments(): Promise<void> {
    const { ok, data } = await api<Enroll[]>("/admin/enrollments");
    if (!ok || !Array.isArray(data)) return;
    if (data.length === 0) {
      enrollList.replaceChildren(el("div", { style: "font-size:12px;color:var(--muted)" }, ["(none yet)"]));
      return;
    }
    enrollList.replaceChildren(
      ...data.map((e) => {
        const row = el("div", {
          style: "border:1px solid var(--border);border-radius:6px;padding:8px 10px",
        });
        row.append(
          el("div", { style: "display:flex;align-items:center;gap:6px" }, [
            el("code", { style: "font-size:12px" }, [e.userCode]),
            el("span", { style: "flex:1" }),
            el("span", { style: `font-size:11px;color:${STATUS_COLOR[e.status]}` }, [e.status]),
          ]),
          el("div", { style: "font-size:11px;color:var(--muted);margin-top:2px" }, [
            `account: ${e.accountId ?? "?"}`,
          ]),
        );
        if (e.status === "pending") {
          const approve = el("button", { class: "primary", style: "font-size:11px;padding:3px 10px;margin-top:6px" }, ["Approve"]) as HTMLButtonElement;
          const deny = el("button", { style: "font-size:11px;padding:3px 10px;margin-top:6px;margin-left:6px;border-color:var(--bad)" }, ["Deny"]) as HTMLButtonElement;
          approve.onclick = async () => {
            approve.disabled = deny.disabled = true;
            await api(`/admin/enrollments/${encodeURIComponent(e.userCode)}/approve`, { method: "POST" });
            refreshEnrollments();
          };
          deny.onclick = async () => {
            approve.disabled = deny.disabled = true;
            await api(`/admin/enrollments/${encodeURIComponent(e.userCode)}/deny`, { method: "POST" });
            refreshEnrollments();
          };
          row.append(el("div", {}, [approve, deny]));
        }
        return row;
      }),
    );
  }

  // Guarded re-render: the poll only repaints when the server data actually
  // changed. Register admission is over NATS, so an account in the directory is
  // immediately dialable — the row is just identity (accountId + how it entered).
  let lastAccountsJson = "";
  async function refreshAccounts(): Promise<void> {
    const { ok, data } = await api<AccountRow[]>("/admin/accounts");
    if (!ok || !Array.isArray(data)) return;
    const json = JSON.stringify(data);
    if (json === lastAccountsJson) return;
    const changed = lastAccountsJson !== "";
    lastAccountsJson = json;
    if (data.length === 0) {
      acctList.replaceChildren(
        el("div", { style: "font-size:12px;color:var(--muted)" }, ["(none yet — approve an enrollment and it appears here)"]),
      );
      return;
    }
    acctList.replaceChildren(
      ...data.map((a) => {
        const row = el("div", { style: "border:1px solid var(--border);border-radius:6px;padding:8px 10px" });
        row.append(
          el("div", { style: "display:flex;align-items:center;gap:6px" }, [
            el("code", { style: "font-size:12px;font-weight:600" }, [a.accountId]),
            el("span", { style: "font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:8px;padding:1px 6px" }, [a.source]),
            el("span", { style: "flex:1" }),
            el("span", { style: "font-size:11px;color:var(--good)" }, ["grantable"]),
          ]),
        );
        return row;
      }),
    );
    // A newly-appeared account (e.g. an approved enrollment) is now grantable —
    // refresh the grant chips so the operator can grant it immediately.
    if (changed) await refreshUsers();
  }

  async function refreshUsers(): Promise<void> {
    const { ok, data } = await api<UsersResponse>("/admin/users");
    if (!ok || !Array.isArray(data.users)) return;
    usersList.replaceChildren(
      ...data.users.map((u) => {
        const chips = data.accounts.map((acct) => {
          const granted = u.allowedAccounts.includes(acct);
          const chip = el(
            "button",
            {
              style:
                "font-size:11px;padding:3px 9px;border-radius:12px;" +
                (granted
                  ? "background:rgba(63,185,80,.15);border-color:var(--good);color:var(--good)"
                  : "opacity:.6"),
            },
            [granted ? `✓ ${acct}` : acct],
          ) as HTMLButtonElement;
          chip.onclick = async () => {
            chip.disabled = true;
            const next = granted
              ? u.allowedAccounts.filter((a) => a !== acct)
              : [...u.allowedAccounts, acct];
            await api(`/admin/users/${encodeURIComponent(u.username)}/accounts`, {
              method: "POST",
              body: { accounts: next },
            });
            refreshUsers();
          };
          return chip;
        });
        return el("div", { style: "border:1px solid var(--border);border-radius:6px;padding:8px 10px" }, [
          el("div", { style: "font-size:12px;font-weight:600;margin-bottom:6px" }, [u.username]),
          el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" }, chips),
        ]);
      }),
    );
  }

  refreshSigningKey();
  refreshEnrollments();
  refreshAccounts();
  refreshUsers();
  const enrollTimer = setInterval(() => {
    refreshEnrollments();
    refreshAccounts();
  }, 2000);

  return () => {
    clearInterval(enrollTimer);
    bodyEl.replaceChildren();
  };
}
