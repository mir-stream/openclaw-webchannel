/**
 * Resolve the smoke-target WebSocket URL from the WS_URL env var — with NO
 * default fallback.
 *
 * Review 2026-07-02 (O3): every smoke script used to default to
 * `ws://127.0.0.1:18789/webchannel/ws`, which is the LIVE gateway. Running a
 * smoke with WS_URL unset therefore sent real prompts (and, via approval.mjs,
 * real tool-execution approvals) to a real configured agent — consuming model
 * quota and potentially executing tools. These scripts are dev-only; the target
 * must be chosen deliberately, never inherited by accident.
 *
 * @returns {string} the WS_URL value
 * @throws exits the process with code 2 if WS_URL is not set
 */
export function requireWsUrl() {
  const url = process.env.WS_URL;
  if (!url) {
    console.error(
      "[smoke] Refusing to run: WS_URL is not set.\n" +
        "  There is no default target. The old default pointed at the LIVE\n" +
        "  gateway (ws://127.0.0.1:18789/webchannel/ws), where a smoke run\n" +
        "  consumes real model quota and can trigger real tool execution.\n" +
        "  Set it explicitly, e.g.:\n" +
        "    WS_URL=ws://127.0.0.1:<dev-port>/webchannel/ws node smoke/ws.mjs",
    );
    process.exit(2);
  }
  return url;
}
