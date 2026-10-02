/**
 * Test-only access to core's outbound target, session-route and delivery
 * orchestration. The pinned SDK (2026.7.1-2) runs them for `message send`, the
 * agent `message` tool and cron but does not export them. Each module is
 * located by its source-region marker and each function by its original
 * export name, so a core bump that moves either fails here instead of letting
 * a test silently exercise nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const distDir = dirname(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/routing")));

export async function loadCoreExport<T>(filePrefix: string, region: string, name: string): Promise<T> {
  for (const file of readdirSync(distDir)) {
    if (!file.startsWith(filePrefix) || !file.endsWith(".js")) continue;
    const source = readFileSync(join(distDir, file), "utf8");
    if (!source.includes(`//#region ${region}\n`)) continue;
    const exported = /^export \{([^}]*)\};?$/m.exec(source)?.[1] ?? "";
    for (const entry of exported.split(",")) {
      const [local, alias] = entry.trim().split(/\s+as\s+/);
      if (local === name) {
        const module = await import(pathToFileURL(join(distDir, file)).href);
        return module[alias ?? local] as T;
      }
    }
  }
  throw new Error(`core export ${name} from ${region} not found under ${distDir}`);
}

export type CoreResolveChannelTarget = (params: {
  cfg: unknown;
  channel: string;
  input: string;
  accountId?: string | null;
  plugin: unknown;
  unknownTargetMode?: "normalized";
}) => Promise<
  | { ok: true; target: { to: string; kind: string; source: string } }
  | { ok: false; error: Error }
>;

export type CoreResolveOutboundSessionRoute = (params: {
  cfg: unknown;
  channel: string;
  plugin: unknown;
  agentId: string;
  accountId?: string | null;
  target: string;
}) => Promise<{
  sessionKey: string;
  baseSessionKey: string;
  recipientSessionExact?: unknown;
  to: string;
} | null>;

export const loadCoreResolveChannelTarget = () => loadCoreExport<CoreResolveChannelTarget>(
  "target-resolver-",
  "src/infra/outbound/target-resolver.ts",
  "resolveChannelTarget",
);

export const loadCoreResolveOutboundSessionRoute = () => loadCoreExport<CoreResolveOutboundSessionRoute>(
  "outbound-session-",
  "src/infra/outbound/outbound-session.ts",
  "resolveOutboundSessionRoute",
);

export type CoreResolveOutboundTargetWithPlugin = (params: {
  plugin: unknown;
  target: { channel: string; to?: string; cfg?: unknown; accountId?: string | null; mode?: string };
}) => { ok: true; to: string } | { ok: false; error: Error } | undefined;

export const loadCoreResolveOutboundTargetWithPlugin = () => loadCoreExport<CoreResolveOutboundTargetWithPlugin>(
  "targets-session-",
  "src/infra/outbound/targets-resolve-shared.ts",
  "resolveOutboundTargetWithPlugin",
);
