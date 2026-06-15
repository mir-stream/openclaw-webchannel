import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Static asset serving for the ClawChannel example widget.
 *
 * This module is intentionally free of `openclaw/plugin-sdk` and `ws` imports:
 * it is pure Node (`node:fs/promises`, `node:path`) so the security-critical
 * path resolver stays trivially unit-testable in isolation.
 */

const ROUTE_PREFIX = "/clawchannel";

/** Minimal extension -> MIME map for the assets the Vite build emits. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Resolve a request URL path to an absolute file path inside `distRoot`.
 *
 * Pure path logic — does NOT touch the filesystem (existence is the caller's
 * job). Returns `null` for anything that must not be served.
 *
 * Traversal containment: after stripping the `/clawchannel` prefix and query
 * string and percent-decoding, the relative request is joined onto `distRoot`
 * and normalized via `path.resolve`. The normalized absolute result is then
 * verified to be `distRoot` itself or to live strictly beneath it
 * (`resolved.startsWith(distRoot + path.sep)`). `..` segments, absolute paths,
 * encoded traversal (`%2e%2e`, `%2f`), and null bytes all either collapse to a
 * location outside `distRoot` (rejected by the containment check) or are
 * rejected outright (null byte). The `ws` sub-path is also rejected so the
 * exact WebSocket route always wins.
 */
export function resolveAssetPath(
  distRoot: string,
  urlPath: string,
): string | null {
  if (typeof urlPath !== "string") return null;

  // Normalize the root so the containment check below compares against a
  // canonical absolute path. A non-canonical caller-supplied root (trailing
  // slash, `..` segments) would otherwise never match `resolved`, making every
  // lookup fail closed. The handler pre-normalizes, so this is belt-and-
  // suspenders for direct callers/tests.
  distRoot = path.resolve(distRoot);

  // Drop query string / fragment — only the path matters for a file lookup.
  let pathPart = urlPath.split("?")[0]!.split("#")[0]!;

  // Percent-decode (e.g. %2e%2e -> .., %2f -> /). Malformed encoding is hostile.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }

  // Reject embedded null bytes (path-poisoning) anywhere in the decoded path.
  if (decoded.includes("\0")) return null;

  // Strip the route prefix. Accept exactly `/clawchannel`, `/clawchannel/`,
  // or `/clawchannel/<rest>`; anything else is not ours.
  let rest: string;
  if (decoded === ROUTE_PREFIX) {
    rest = "";
  } else if (decoded.startsWith(ROUTE_PREFIX + "/")) {
    rest = decoded.slice(ROUTE_PREFIX.length + 1);
  } else {
    return null;
  }

  // The WebSocket sub-path is owned by the exact `/clawchannel/ws` route.
  // Defensively never serve a file for it.
  if (rest === "ws" || rest.startsWith("ws/")) return null;

  // Bare prefix root maps to the SPA entry point.
  if (rest === "" || rest === "/") {
    rest = "index.html";
  }

  // Reject anything that resolves to an absolute path before joining. A leading
  // slash here would make path.resolve ignore distRoot entirely.
  if (path.isAbsolute(rest)) return null;

  const resolved = path.resolve(distRoot, rest);

  // Containment check: the normalized absolute path must be distRoot itself or
  // strictly inside it. This is what defeats `..` traversal post-normalization.
  if (resolved !== distRoot && !resolved.startsWith(distRoot + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Build an HTTP handler that serves files from the widget `dist/`.
 *
 * Returns `true` once it has written a response (handled). The caller registers
 * this on a `prefix` route for `/clawchannel/`; the exact `/clawchannel/ws`
 * route takes precedence, so WS upgrades are never seen here.
 */
export function createStaticAssetsHandler(
  distRoot: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  // Normalize once so the containment comparison is against a canonical root.
  const root = path.resolve(distRoot);

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    try {
      // If the build output is missing entirely, fail with an actionable hint
      // rather than a confusing 404 per asset.
      let distExists = true;
      try {
        const s = await stat(root);
        distExists = s.isDirectory();
      } catch {
        distExists = false;
      }
      if (!distExists) {
        console.warn(
          "[clawchannel] widget dist not found — build the widget first " +
            "(npm run build in clawchannel/widget)",
        );
        res.statusCode = 503;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(
          "clawchannel: widget not built. Run `npm run build` in clawchannel/widget.",
        );
        return true;
      }

      const filePath = resolveAssetPath(root, req.url ?? "");
      if (filePath === null) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("clawchannel: not found");
        return true;
      }

      let body: Buffer;
      try {
        body = await readFile(filePath);
      } catch (err) {
        // A missing file (ENOENT) or a request resolving to a directory
        // (EISDIR — e.g. `/clawchannel/assets`) are both "no such asset" from
        // the client's perspective: return 404 rather than falling through to
        // the generic 500.
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "EISDIR") {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("clawchannel: not found");
          return true;
        }
        throw err;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeFor(filePath));
      res.end(body);
      return true;
    } catch (err) {
      console.warn(`[clawchannel] static asset error: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("clawchannel: internal error");
      return true;
    }
  };
}
