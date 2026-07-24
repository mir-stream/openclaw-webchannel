/**
 * WebChannel ChannelSetupWizard (interactive `openclaw channels add`).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Before this wizard, onboarding a webchannel account required HAND-WRITING the
 * full `channels.webchannel.accounts.<id>` auth/nats block via `config patch`
 * before `channels add`. This declarative wizard drives the interactive path:
 * bare `openclaw channels add` → pick WebChannel → prompt for tenant + SaaS base
 * URL → `finalize` writes the
 * COMPLETE, enroll-ready block. There is deliberately NO issuer prompt: the
 * issuer is SaaS-delivered at enrollment (see the textInputs note).
 *
 * NOTE: the interactive wizard writes CONFIG ONLY. Core runs the device-flow
 * enroll (`webchannelSetup.afterAccountConfigWritten`) only on the non-interactive
 * `--flag` path — the declarative wizard adapter core builds has no
 * `afterConfigWritten` hook. So after authoring config via the bare wizard,
 * complete enrollment by running the `--flag` form (or re-running acquisition).
 *
 * ── Two seams, one writer ───────────────────────────────────────────────────
 * The NON-interactive `--flag` form does NOT run this wizard (core only runs the
 * declarative wizard for a bare, flagless `channels add`); it writes the same
 * block through `webchannelSetup.applyAccountConfig`. Both seams funnel their
 * full-block write through the single pure `buildFullAccountPatch` in setup.ts —
 * `finalize` here reuses `applyAccountConfig` so there is exactly one write path.
 *
 * ── Per-field funnel safety ──────────────────────────────────────────────────
 * The generic wizard driver funnels each text input through the setup adapter
 * ONE FIELD AT A TIME (openclaw src/channels/plugins/setup-wizard.ts). An
 * unconditional full-block write would fire mid-wizard before `saasBaseUrl` is
 * collected, so every text input supplies a NO-OP `applySet`: the collected
 * value still lands in `credentialValues` for `finalize`, but nothing is written
 * until `finalize` performs the single atomic full-block write.
 */

import { existsSync } from "node:fs";

import type {
  ChannelSetupWizard,
  ChannelSetupWizardTextInput,
} from "openclaw/plugin-sdk/setup";

import { WEBCHANNEL_ID } from "./channel-contract.js";
import {
  DEFAULT_WEBCHANNEL_ACCOUNT_ID,
  accountCredentialPath,
  canonicalizeAccountId,
  loadPersistedCredentialDocument,
  resolveAcquisitionIdentity,
  resolveWebchannelAccountConfig,
} from "./account-config.js";
import {
  resolveEnrolledSaasBaseUrl,
  type WebchannelNatsConfig,
} from "./nats-credential-source.js";
import { webchannelSetup } from "./setup.js";

/**
 * `inputKey` is typed `keyof ChannelSetupInput` (a fixed core shape that does not
 * know webchannel's fields). Because every text input supplies its own
 * `applySet` and `finalize` reads the collected values back by these keys, the
 * key is purely a local `credentialValues` label — cast to the required type so
 * we can use semantic names (tenant/saasBaseUrl/issuer) rather than repurposing
 * unrelated generic keys.
 */
type InputKey = ChannelSetupWizardTextInput["inputKey"];
const KEY = {
  tenant: "tenant" as InputKey,
  saasBaseUrl: "saasBaseUrl" as InputKey,
} as const;

/** A no-op text-input writer — the real write happens once, in `finalize`. */
const noopApplySet: NonNullable<ChannelSetupWizardTextInput["applySet"]> = ({ cfg }) => cfg;

/** Validate an http(s) URL for the SaaS base URL prompt. */
export function validateHttpUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Enter a valid URL, e.g. https://saas.example.com";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http:// or https://";
  }
  return undefined;
}

/** Read a string leaf off a resolved account config, or undefined. */
function accountString(account: Record<string, unknown>, key: string): string | undefined {
  const value = account[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const webchannelSetupWizard: ChannelSetupWizard = {
  channel: WEBCHANNEL_ID,
  // Declarative-detectable: `status` + `credentials` (empty is accepted, mirroring
  // WhatsApp) is what core's registry keys on to treat this as a declarative wizard.
  credentials: [],
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "not configured",
    resolveConfigured: ({ cfg, accountId }) => {
      const id = canonicalizeAccountId(accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID);
      const account = resolveWebchannelAccountConfig(cfg, id);
      const mode =
        (account.nats as WebchannelNatsConfig | undefined)?.credentials?.mode ??
        "enrolled";
      if (mode !== "enrolled") {
        return Boolean((account.auth as { jwt?: unknown } | undefined)?.jwt);
      }
      // A path by itself is not readiness. Count enrolled material only when
      // its complete v2 identity matches the effective configured account.
      if (!existsSync(accountCredentialPath(id))) return false;
      const identity = resolveAcquisitionIdentity(cfg, id);
      const saasBaseUrl = resolveEnrolledSaasBaseUrl({
        natsConfig: account.nats as WebchannelNatsConfig | undefined,
        ...(identity.saasBaseUrl !== undefined
          ? { saasBaseUrl: identity.saasBaseUrl }
          : {}),
      });
      if (!saasBaseUrl) return false;
      try {
        return loadPersistedCredentialDocument({
          tenant: identity.tenant,
          accountId: id,
          saasBaseUrl,
        }).status === "match";
      } catch {
        // Invalid effective identity is unconfigured; status inspection must not
        // turn malformed config into an uncaught wizard failure.
        return false;
      }
    },
    resolveStatusLines: ({ cfg, accountId, configured }) => {
      const id = canonicalizeAccountId(accountId ?? DEFAULT_WEBCHANNEL_ACCOUNT_ID);
      const account = resolveWebchannelAccountConfig(cfg, id);
      const tenant = accountString(account, "tenant") ?? "unset";
      const saas =
        (account.saas as { baseUrl?: string } | undefined)?.baseUrl ?? "unset";
      return [
        `WebChannel (${id}): ${configured ? "configured" : "not configured"} ` +
          `— tenant=${tenant}, saas=${saas}`,
      ];
    },
  },
  textInputs: [
    {
      inputKey: KEY.tenant,
      message: "WebChannel tenant id",
      required: true,
      initialValue: ({ cfg, accountId }) =>
        accountString(resolveWebchannelAccountConfig(cfg, accountId), "tenant") ??
        "default-tenant",
      applySet: noopApplySet,
    },
    {
      inputKey: KEY.saasBaseUrl,
      message: "WebChannel SaaS base URL (e.g. https://saas.example.com)",
      required: true,
      initialValue: ({ cfg, accountId }) =>
        (resolveWebchannelAccountConfig(cfg, accountId).saas as { baseUrl?: string } | undefined)
          ?.baseUrl,
      validate: ({ value }) => validateHttpUrl(value),
      applySet: noopApplySet,
    },
    // NO issuer prompt. The issuer is a trust FACT the SaaS DECLARES at
    // enrollment (EnrollmentResult.issuer, precedence pin > delivered >
    // derived) — prompting for it here would prefill the base URL and write an
    // add-time PIN on every interactive add, permanently shadowing the
    // SaaS-delivered value (including across re-enrollments that change it).
    // Operators who genuinely need a pin (proxy / logical issuer) use the
    // non-interactive `--flag` form's issuer param — the pure escape hatch.
    // An EXISTING pin is never clobbered (buildFullAccountPatch no-clobber
    // merge), so re-running the wizard on a pinned account is safe.
  ],
  /**
   * The single atomic write for the interactive path. Maps the collected values
   * onto the setup adapter's full-block seam (`saasBaseUrl` present ⇒
   * `buildFullAccountPatch`), so the interactive and non-interactive paths share
   * one writer and one merge/no-clobber policy. JWT aud is always accountId.
   */
  finalize: ({ cfg, accountId, credentialValues }) => {
    const saasBaseUrl = credentialValues[KEY.saasBaseUrl];
    if (!saasBaseUrl) {
      // No SaaS base URL was collected (e.g. the required prompt was skipped in a
      // non-interactive harness) — nothing enroll-ready to write.
      return { cfg };
    }
    // Canonicalize before writing: the canonical account id is also the JWT
    // audience expected by the runtime verifier.
    const id = canonicalizeAccountId(accountId);
    const next = webchannelSetup.applyAccountConfig({
      cfg,
      accountId: id,
      input: {
        baseUrl: saasBaseUrl,
        url: credentialValues[KEY.tenant],
        // issuer deliberately NOT collected/written — see the textInputs note.
      },
    });
    return { cfg: next };
  },
  completionNote: {
    title: "WebChannel next steps",
    lines: [
      "Bind an agent to this account, then start the gateway:",
      "  openclaw agents bind --bind webchannel:<account> --agent <agent>",
      "  openclaw gateway run",
      "",
      'Note: dmSecurity is set to "open" (demo-grade). It admits ALL inbound DMs ' +
        "and is NOT a safe production default — tighten it before exposing the " +
        "account publicly.",
    ],
  },
};
