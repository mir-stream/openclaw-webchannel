import type { IncomingMessage, ServerResponse } from "node:http";
import { EnrollmentValidationError, type DeviceFlowEnrollment } from "./device-flow-enrollment.js";
import type { AgentKeyRegistry } from "./agent-key-registry.js";
import { authorizeEnrollmentAdmin } from "./admin-auth.js";

export type EnrollmentHttpProfile = "reference" | "demo";
export type EnrollmentHttpAuthorization =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; error: string };

class BadRequestError extends Error {}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BadRequestError("invalid JSON body");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof BadRequestError) throw error;
    throw new BadRequestError("invalid JSON body");
  }
}

function decoded(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new BadRequestError("malformed URL encoding"); }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}

/** Internal handler shared by the reference server and demo. */
export function createEnrollmentHttpHandler(options: {
  profile: EnrollmentHttpProfile;
  adminToken?: string;
  /** Profile-specific admin boundary. Runs before request-body parsing or mutation. */
  authorize?: (req: IncomingMessage) => EnrollmentHttpAuthorization | Promise<EnrollmentHttpAuthorization>;
  enrollment: Pick<DeviceFlowEnrollment, "enroll" | "poll" | "approve" | "deny">;
  registry: AgentKeyRegistry;
  bootstrap: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  defaultTenant?: string;
  onApproved?: (userCode: string) => void | Record<string, unknown> | Promise<void | Record<string, unknown>>;
  onDenied?: (userCode: string) => void | Promise<void>;
  log?: (line: string) => void;
}) {
  let loggedMissingAdminConfiguration = false;
  const authorize = options.authorize ?? ((req: IncomingMessage) =>
    authorizeEnrollmentAdmin(options.adminToken, req.headers.authorization));

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

      const url = new URL(req.url ?? "/", "http://handler.invalid");
      const openPath = url.pathname;
      const demo = openPath.match(/^\/admin\/enrollments\/([^/]+)\/(approve|deny)$/);
      const demoRevoke = openPath.match(/^\/admin\/accounts\/([^/]+)\/revoke$/);
      const action = demo?.[2] ?? (demoRevoke ? "revoke" : openPath.slice(1));
      const isAdminAction = req.method === "POST" && (["approve", "deny", "revoke"] as string[]).includes(action);

      if (isAdminAction) {
        const auth = await authorize(req);
        if (!auth.ok) {
          if (auth.status === 503 && !loggedMissingAdminConfiguration) {
            loggedMissingAdminConfiguration = true;
            options.log?.(`[${options.profile}] enrollment admin authorization is not configured; refusing operator actions`);
          }
          return json(res, auth.status, { error: auth.error });
        }
      }

      const payload = req.method === "POST" ? await body(req) : {};
      if (openPath === "/enroll" && req.method === "POST") {
        try { return json(res, 200, await options.enrollment.enroll(payload as never)); }
        catch (error) {
          if (error instanceof EnrollmentValidationError) return json(res, 400, { error: error.message });
          throw error;
        }
      }
      if (openPath === "/poll" && req.method === "POST") {
        const result = await options.enrollment.poll(payload as never);
        return json(res, "error" in result ? 400 : 200, result);
      }
      if (openPath === "/bootstrap" && req.method === "POST") return json(res, 200, await options.bootstrap());
      if (!isAdminAction) return json(res, 404, { error: "not found" });

      const userCode = demo ? decoded(demo[1]) : String(payload.user_code ?? "");
      if (action === "approve") {
        const replacement = typeof payload.replaceActivationId === "string" ? payload.replaceActivationId : undefined;
        const outcome = await options.enrollment.approve(userCode, { ...(replacement ? { replaceActivationId: replacement } : {}) });
        if (outcome.kind === "conflict") return json(res, 409, { error: "conflict", activationId: outcome.existing?.activationId ?? null, fingerprint: outcome.existing?.keyIdFingerprint ?? null, enrolledAt: outcome.existing?.enrolledAt ?? null });
        if (outcome.kind === "revoked_key") return json(res, 410, { error: "revoked_key" });
        if (outcome.kind === "rejected") return json(res, 404, { ...(options.profile === "reference" ? { success: false } : {}), error: "rejected" });
        options.log?.(`[${options.profile}] approved ${userCode}`);
        const extra = await options.onApproved?.(userCode);
        return json(res, 200, options.profile === "reference"
          ? { success: true, peerId: outcome.result.peerId, ...(extra ?? {}) }
          : { approved: true, peerId: outcome.result.peerId, ...(extra ?? {}) });
      }
      if (action === "deny") {
        const denied = await options.enrollment.deny(userCode);
        if (denied) await options.onDenied?.(userCode);
        return json(res, denied ? 200 : 404, options.profile === "reference" ? { success: denied } : { denied });
      }
      const tenant = String(payload.tenant ?? options.defaultTenant ?? "");
      const accountId = demoRevoke ? decoded(demoRevoke[1]) : String(payload.accountId ?? "");
      const revoked = await options.registry.revokeActive(tenant, accountId);
      return json(res, revoked ? 200 : 404, { revoked });
    } catch (error) {
      if (error instanceof BadRequestError) {
        if (!res.headersSent) return json(res, 400, { error: error.message });
      } else {
        options.log?.(`[${options.profile}] enrollment HTTP handler error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        if (!res.headersSent) return json(res, 500, { error: "internal server error" });
      }
      if (!res.writableEnded) res.end();
    }
  };
}

type HandlerOptions = Parameters<typeof createEnrollmentHttpHandler>[0];
export const createReferenceEnrollmentHttpHandler = (options: Omit<HandlerOptions, "profile">) => createEnrollmentHttpHandler({ ...options, profile: "reference" });
export const createDemoEnrollmentHttpHandler = (options: Omit<HandlerOptions, "profile">) => createEnrollmentHttpHandler({ ...options, profile: "demo" });
