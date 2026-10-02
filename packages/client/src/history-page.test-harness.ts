/**
 * #401 — make a fixture `history` frame the answer to THIS device's own request.
 *
 * Since #401 a load-older PAGE rides the peer's shared `.out` with the
 * `load_history.nonce` it answers, and the wrapper folds only a page echoing a
 * nonce it is waiting for (`claimHistoryPage`). Suites that inject a page-shaped
 * `history` frame (no `highWaterSeq`) straight into `handleMessage` were written
 * when every such frame was folded; what they test is how a page this device
 * asked for merges, so this gives the frame exactly that: a nonce minted through
 * the wrapper's own request path and echoed back. A snapshot (`highWaterSeq`
 * present) or a frame that already carries a `nonce` is returned unchanged.
 *
 * The `.test-harness.ts` suffix keeps it out of the published build
 * (`tsconfig.build.json`). It has NO imports.
 */
export function ownHistoryPage<F extends { type: string }>(wrapper: unknown, frame: F): F {
  const fields = frame as F & { highWaterSeq?: unknown; nonce?: unknown };
  if (frame.type !== "history" || fields.highWaterSeq !== undefined || fields.nonce !== undefined) {
    return frame;
  }
  const nonce = (wrapper as { mintHistoryPageNonce(): string }).mintHistoryPageNonce();
  return { ...frame, nonce };
}
