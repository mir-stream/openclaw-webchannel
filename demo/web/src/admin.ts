/**
 * Admin panel — the SaaS-as-authority surface (admin session only).
 *
 *  - Enrollment requests: live list with Approve / Deny (scene ②'s "authority
 *    can say no"), plus the terminal states (approved / denied / expired).
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

const STATUS_COLOR: Record<Enroll["status"], string> = {
  pending: "var(--warn)",
  approved: "var(--good)",
  denied: "var(--bad)",
  expired: "var(--muted)",
};

export function createAdminPanel(bodyEl: HTMLElement, _config: DemoConfig): () => void {
  bodyEl.replaceChildren();

  const enrollSection = el("div", { style: "margin-bottom:18px" });
  const enrollList = el("div", { style: "display:flex;flex-direction:column;gap:8px" });
  enrollSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["Enrollment requests"]),
    enrollList,
  );

  const usersSection = el("div");
  const usersList = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
  usersSection.append(
    el("div", { style: "font-size:11px;text-transform:uppercase;color:var(--muted);margin-bottom:8px" }, ["User → agent grants"]),
    usersList,
  );

  bodyEl.append(enrollSection, usersSection);

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

  refreshEnrollments();
  refreshUsers();
  const enrollTimer = setInterval(refreshEnrollments, 2000);

  return () => {
    clearInterval(enrollTimer);
    bodyEl.replaceChildren();
  };
}
