#!/usr/bin/env bash
# P0-3 S4 — SHARED adversarial negative legs N1-N3, sourced by every mode runner
# (A/B/C) so all three run the SAME suite (no drift). Depends on the caller having
# exported: REPO, OCH, ISS (issuer base URL), NATS_WS, TENANT, ACCT_A, ACCT_B,
# GW_PID, and $OCH/gateway.log. `node --import tsx` runs the drivers (the precedent
# is run-enrolled-transport.sh driving enrolled-transport-roundtrip.ts that way).
#
# N3 SIGSTOP fail-safe (plan §D5 / R4-4): the gateway is paused during the MITM
# leg. A STOPPED process ignores TERM/pkill, so a naive cleanup would leave a
# zombie holding the (self-hosted, single) runner forever. The contract:
#   - resume with `kill -CONT` BEFORE any TERM, on EVERY exit path;
#   - the resume + a final SIGKILL fallback are UNCONDITIONAL (never gated on the
#     GW_STOPPED flag — that closes the STOP-before-flag race; the flag is
#     diagnostic only);
#   - after a clean resume+wait, GW_PID stays valid for the caller's own cleanup.
# The CALLER's cleanup() MUST also `kill -CONT "$GW_PID"` before its TERM (see the
# n3_safety_resume helper) — sourced runners wire it in their trap.

# Resume a possibly-stopped gateway unconditionally. Safe to call repeatedly and
# from a trap; never fails the script.
n3_safety_resume() {
  [ -n "${GW_PID:-}" ] || return 0
  kill -CONT "$GW_PID" 2>/dev/null || true
}

# Run N1 + N2 (shared driver). Best-effort greps the gateway log for the N1
# pre-register drop line, but the PASS gate is the driver's own assertions.
run_negative_legs_n1_n2() {
  echo "[neg] running N1+N2 (accountA=$ACCT_A accountB=$ACCT_B)…"
  set +e
  WEBCHANNEL_ISSUER_URL="$ISS" \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_TENANT="$TENANT" \
  WEBCHANNEL_ACCOUNT_A="$ACCT_A" \
  WEBCHANNEL_ACCOUNT_B="$ACCT_B" \
    node --import tsx "$REPO/e2e/local/negative-legs.ts"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "[neg] ✗ N1/N2 FAILED (rc=$rc) — gateway log tail:"; tail -30 "$OCH/gateway.log" 2>/dev/null || true
    return "$rc"
  fi
  # Best-effort: the gateway MAY log the no-registered-session-key drop; its
  # absence is fine (pre-register the subject has no subscriber — see N1 note).
  if grep -q "no registered session key" "$OCH/gateway.log" 2>/dev/null; then
    echo "[neg] (info) gateway logged a 'no registered session key' drop"
  fi
  echo "[neg] ✓ N1+N2 passed"
  return 0
}

# Run N3 (2-phase SIGSTOP-MITM key-swap). Orchestrates the SIGSTOP/SIGCONT with
# the fail-safe. Requires GW_PID. Returns non-zero on any assertion failure.
#
# N3 runs against ACCT_B, which every mode configures as dmSecurity:"open". The
# recovery leg registers a FRESH RANDOM peerId and must complete a real echo
# round-trip — an allowlist account (e.g. run-all-real's ACCT_A, pinned to its own
# echo peer) would deny that random peer's message ("inbound denied … not-
# allowlisted") and the recovery would spuriously fail. N1/N2 stay on ACCT_A.
run_negative_leg_n3() {
  local n3_peer="n3-victim-${RANDOM}"
  local n3_account="$ACCT_B"
  echo "[neg] running N3 (SIGSTOP-MITM key-swap, peer=$n3_peer, account=$n3_account [open])…"

  # --- ATTACK: pause the gateway so the MITM is the sole responder. ----------
  GW_STOPPED=1
  kill -STOP "$GW_PID" 2>/dev/null || true
  echo "[neg] gateway SIGSTOPped (pid=$GW_PID)"

  # Everything from here to SIGCONT is wrapped so ANY failure still resumes the
  # gateway before returning (the caller's trap also resumes, belt-and-suspenders).
  set +e
  ( WEBCHANNEL_ISSUER_URL="$ISS" \
    WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
    WEBCHANNEL_TENANT="$TENANT" \
    WEBCHANNEL_ACCOUNT_A="$n3_account" \
    WEBCHANNEL_N3_PEER="$n3_peer" \
      node --import tsx "$REPO/e2e/local/n3-key-swap.ts" --phase=attack )
  local attack_rc=$?
  set -e

  # --- RESUME: unconditional, BEFORE any further control flow. ----------------
  n3_safety_resume
  GW_STOPPED=0
  echo "[neg] gateway SIGCONTed"
  # Liveness after resume — a stopped-then-killed pid would fail here.
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "[neg] ✗ N3: gateway pid $GW_PID not alive after SIGCONT"; return 5
  fi
  if [ "$attack_rc" -ne 0 ]; then
    echo "[neg] ✗ N3 attack FAILED (rc=$attack_rc) — gateway log tail:"; tail -30 "$OCH/gateway.log" 2>/dev/null || true
    return "$attack_rc"
  fi

  # --- RECOVERY: fresh client against the live gateway (no MITM). -------------
  set +e
  WEBCHANNEL_ISSUER_URL="$ISS" \
  WEBCHANNEL_NATS_URL="ws://127.0.0.1:$NATS_WS" \
  WEBCHANNEL_TENANT="$TENANT" \
  WEBCHANNEL_ACCOUNT_A="$n3_account" \
  WEBCHANNEL_N3_PEER="$n3_peer" \
    node --import tsx "$REPO/e2e/local/n3-key-swap.ts" --phase=recovery
  local recovery_rc=$?
  set -e
  if [ "$recovery_rc" -ne 0 ]; then
    echo "[neg] ✗ N3 recovery FAILED (rc=$recovery_rc) — gateway log tail:"; tail -30 "$OCH/gateway.log" 2>/dev/null || true
    return "$recovery_rc"
  fi
  echo "[neg] ✓ N3 passed (forged swap rejected secure-channel-failed; fresh client recovered)"
  return 0
}

# Convenience: run the full N1-N3 suite; return non-zero on the first failure.
run_all_negative_legs() {
  run_negative_legs_n1_n2 || return $?
  run_negative_leg_n3 || return $?
  echo "[neg] ✓ ALL negative legs (N1-N3) passed"
  return 0
}
