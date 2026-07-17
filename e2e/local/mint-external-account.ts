// P0-3 S4 — Mode C: synthesize an EXTERNAL (managed / Synadia-shape) NATS account.
//
// Emits (as JSON on stdout) the material a resolver-backed nats-server + the
// reference SaaS in external mode need to prove that SaaS-minted, signing-key-
// signed, `issuer_account`-stamped creds actually CONNECT to that server (the
// existing external-nats-account.test.ts only checks JWT SHAPE):
//   - operatorJwt      → nats.conf `operator:`
//   - accountPublicKey → the account identity (A…); resolver_preload key + issuer_account
//   - accountJwt       → resolver_preload value (account signed by the operator, listing
//                        the delegated signing key in `signing_keys`)
//   - signingSeed      → the SaaS `NATS_ACCOUNT_SIGNING_SEED` (mints users on behalf of
//                        the account; iss = signing-key public, issuer_account = accountPub)
//
// @nats-io/jwt exports encodeOperator/encodeAccount/encodeUser (confirmed). Run via
// `node --import tsx`. No downgrade path: if the real resolver refuses these creds
// Mode C BLOCKS (the plan forbids weakening the check).

import { createOperator, createAccount } from "@nats-io/nkeys";
import { encodeOperator, encodeAccount } from "@nats-io/jwt";

async function main(): Promise<void> {
  // 1. Operator.
  const operatorKp = createOperator();
  const operatorPublic = operatorKp.getPublicKey();
  const operatorJwt = await encodeOperator("wc-e2e-operator", operatorKp);

  // 2. Account identity + a DISTINCT delegated signing key (Synadia shape).
  const accountKp = createAccount();
  const accountPublicKey = accountKp.getPublicKey(); // A… identity (issuer_account)
  const signingKp = createAccount();
  const signingPublic = signingKp.getPublicKey(); // A… signing key (iss of user JWTs)
  const signingSeed = new TextDecoder().decode(signingKp.getSeed()); // SA…

  // 3. Account JWT: signed BY the operator, listing the signing key so the resolver
  //    accepts user JWTs that `iss` = signingPublic on behalf of this account.
  const accountJwt = await encodeAccount(
    "wc-e2e-account",
    accountKp,
    {
      signing_keys: [signingPublic],
      // Unlimited (-1) account limits. The default account JWT caps active
      // connections very low, so the enrollment-server + agent(s) + browser(s) +
      // MITM tripped `maximum account active connections exceeded` on the first
      // dial. -1 is the NATS "unlimited" sentinel.
      limits: { conn: -1, leaf: -1, data: -1, payload: -1, subs: -1 },
    },
    { signer: operatorKp },
  );

  process.stdout.write(
    JSON.stringify({ operatorPublic, operatorJwt, accountPublicKey, signingPublic, accountJwt, signingSeed }) + "\n",
  );
}

main().catch((err) => {
  console.error("[mint-external-account] error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
