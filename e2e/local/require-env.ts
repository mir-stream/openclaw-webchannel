/**
 * Required-environment helper for the e2e/local drivers.
 *
 * WHY THESE ARE NOT OPTIONAL (#118)
 *
 * Every driver under e2e/local/ is launched by its run-*.sh gate, which passes
 * the topology in via env. The drivers nonetheless carried `?? "ws://127.0.0.1:
 * <literal>"` fallbacks, and because those fallbacks never execute during a real
 * gate run, nothing ever noticed when they drifted:
 *
 *   * two-account-isolation-roundtrip.ts defaulted to :18222 — the nats-server
 *     monitor port of packages/plugin/src/nats-transport-realserver.test.ts.
 *   * turn-outcome-roundtrip.ts defaulted to :18422 / :3921 — run-enrolled-
 *     transport.sh's ports, not its own.
 *
 * A silent fallback to the wrong port is strictly worse than a crash: it either
 * fights another suite for a socket or connects somewhere plausible and proves
 * nothing. So the drivers now demand the variable and name the gate that sets
 * it. Ports live in exactly one place — e2e/local/ports.json.
 */

/** Read an env var the launching gate is required to set, or fail loudly. */
export function requireEnv(name: string, gate: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `[FAIL] ${name} is not set.\n` +
        `       This driver does not guess ports — a stale default is how the ` +
        `monitor-port collision (#118) survived.\n` +
        `       Run it through its gate: ./e2e/local/${gate}`,
    );
    process.exit(2);
  }
  return value;
}

/** Same, for a numeric env var (ports). */
export function requireEnvPort(name: string, gate: string): number {
  const raw = requireEnv(name, gate);
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[FAIL] ${name}="${raw}" is not a valid port`);
    process.exit(2);
  }
  return port;
}
