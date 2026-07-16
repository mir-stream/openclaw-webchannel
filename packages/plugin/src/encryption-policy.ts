/**
 * Encryption policy for the NATS WebChannel entry (fail-closed boot guard).
 *
 * The NATS entry is encrypt-by-construction: the relay (an untrusted shared
 * NATS bus) must only ever observe ChaCha20-Poly1305 ciphertext. There is no
 * sanctioned plaintext NATS deployment. This module is the single decision
 * point the entry consults at boot:
 *
 *  - default (encryption unset) or `mode:"required"` → return crypto options;
 *    the entry constructs the encrypted `NatsChannel`.
 *  - `mode:"disabled"` (an explicit attempt to run without encryption) → THROW;
 *    the entry refuses to start and therefore never emits plaintext to the relay.
 *
 * This satisfies seed acceptance-criterion 3(a) / exit-condition
 * `EncryptedChannelWired`: "a deployment without encryption refuses to start
 * and never emits plaintext to the relay (fail-closed)".
 *
 * Keeping the decision in a pure function (no plugin `api` dependency) makes the
 * fail-closed behaviour directly unit-testable.
 */

import type { NatsChannelCryptoOptions } from "./nats-channel.js";

/** Operator-facing encryption configuration under `channels.webchannel.encryption`. */
export type WebchannelEncryptionConfig = {
  /**
   * `"required"` (or unset) keeps the channel encrypt-by-construction.
   * `"disabled"` is rejected at boot — there is no plaintext NATS deployment.
   */
  mode?: "required" | "disabled";
};

/** Resolved policy the entry applies when constructing the channel. */
export type EncryptionPolicy = {
  /** Crypto options to pass to the `NatsChannel` constructor (always encrypted). */
  crypto: NatsChannelCryptoOptions;
};

/**
 * Error thrown when a deployment explicitly disables encryption. The entry
 * treats this as fatal — it refuses to boot rather than fall back to plaintext.
 */
export class EncryptionDisabledError extends Error {
  constructor() {
    super(
      "webchannel-nats: refusing to start — encryption is disabled " +
        "(channels.webchannel.encryption.mode='disabled'), but the NATS channel is " +
        "encrypt-by-construction (fail-closed). The relay must only ever see ciphertext. " +
        "Disabling encryption is unsupported on the NATS-only surface; remove the override " +
        "to run encrypted.",
    );
    this.name = "EncryptionDisabledError";
  }
}

/**
 * Resolve the encryption policy for the NATS entry.
 *
 * @throws {EncryptionDisabledError} when encryption is explicitly disabled.
 */
export function resolveEncryptionPolicy(
  cfg: WebchannelEncryptionConfig | undefined,
): EncryptionPolicy {
  if (cfg?.mode === "disabled") {
    throw new EncryptionDisabledError();
  }
  // Unset (secure-by-default) and "required" both yield an encrypted channel.
  return { crypto: {} };
}
