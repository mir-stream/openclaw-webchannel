import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, it, expect } from "vitest";

import {
  createStaticAssetsHandler,
  resolveAssetPath,
} from "./static-assets.js";

// A canonical fake dist root. The resolver is pure path logic and must never
// touch the filesystem, so this directory does not need to exist.
const DIST = path.resolve("/tmp/fakedist");

describe("resolveAssetPath", () => {
  it("maps the bare prefix root to index.html", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/")).toBe(
      path.join(DIST, "index.html"),
    );
    expect(resolveAssetPath(DIST, "/clawchannel")).toBe(
      path.join(DIST, "index.html"),
    );
  });

  it("strips a query string off the root", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/?v=1")).toBe(
      path.join(DIST, "index.html"),
    );
  });

  it("resolves a normal nested asset inside dist", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/assets/x.js")).toBe(
      path.join(DIST, "assets", "x.js"),
    );
  });

  it("resolves an asset with a query string", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/assets/x.js?hash=abc")).toBe(
      path.join(DIST, "assets", "x.js"),
    );
  });

  it("rejects plain ../ traversal", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/../../etc/passwd")).toBeNull();
  });

  it("rejects percent-encoded traversal", () => {
    expect(
      resolveAssetPath(DIST, "/clawchannel/..%2f..%2fetc/passwd"),
    ).toBeNull();
    expect(
      resolveAssetPath(DIST, "/clawchannel/%2e%2e%2f%2e%2e%2fetc/passwd"),
    ).toBeNull();
  });

  it("rejects an absolute-ish path after the prefix", () => {
    // Decodes to /clawchannel//etc/passwd -> rest is an absolute path.
    expect(resolveAssetPath(DIST, "/clawchannel/%2fetc%2fpasswd")).toBeNull();
  });

  it("rejects paths containing a null byte", () => {
    expect(
      resolveAssetPath(DIST, "/clawchannel/index.html%00.png"),
    ).toBeNull();
  });

  it("rejects the ws sub-path (owned by the exact WS route)", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/ws")).toBeNull();
    expect(resolveAssetPath(DIST, "/clawchannel/ws/foo")).toBeNull();
  });

  it("rejects paths outside the route prefix", () => {
    expect(resolveAssetPath(DIST, "/other/thing.js")).toBeNull();
    expect(resolveAssetPath(DIST, "/clawchannelx/thing.js")).toBeNull();
  });

  it("rejects malformed percent-encoding", () => {
    expect(resolveAssetPath(DIST, "/clawchannel/%zz")).toBeNull();
  });

  it("does not leak into a sibling directory sharing the root's prefix", () => {
    // Regression for the `+ path.sep` containment boundary. With distRoot
    // `/var/app/dist`, a sibling like `/var/app/dist-evil` shares the
    // `/var/app/dist` string prefix. A bare `startsWith(distRoot)` (without the
    // trailing separator) would wrongly accept it; the `+ path.sep` form must
    // reject it. We craft a request that resolves to the sibling via `..`.
    const root = path.resolve("/var/app/dist");
    const result = resolveAssetPath(
      root,
      "/clawchannel/..%2fdist-evil%2fsecret.js",
    );
    if (result !== null) {
      // If anything is returned it must stay strictly inside distRoot.
      expect(result === root || result.startsWith(root + path.sep)).toBe(true);
      expect(result.startsWith(path.resolve("/var/app/dist-evil"))).toBe(false);
    }
  });

  it("does not escape on double-encoded traversal", () => {
    // `%252e%252e%2f` is `%2e%2e%2f` after one decode (the resolver decodes
    // exactly once), so `..` never materializes as a path separator — it stays
    // a literal filename component inside distRoot. Assert it does not escape.
    const result = resolveAssetPath(
      DIST,
      "/clawchannel/%252e%252e%2fetc%2fpasswd",
    );
    if (result !== null) {
      expect(result === DIST || result.startsWith(DIST + path.sep)).toBe(true);
    }
  });

  it("normalizes a non-canonical distRoot (trailing slash / .. segments)", () => {
    // A non-canonical root must not make every lookup fail closed.
    const canonical = path.join(DIST, "index.html");
    expect(resolveAssetPath(DIST + "/", "/clawchannel/")).toBe(canonical);
    expect(resolveAssetPath(DIST + "/sub/..", "/clawchannel/")).toBe(canonical);
  });
});

/** Minimal fake response capturing what the handler writes. */
interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader(name: string, value: string): void;
  end(chunk?: unknown): void;
}

function makeRes(): FakeResponse {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: unknown) {
      this.body = chunk;
    },
  };
}

function makeReq(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe("createStaticAssetsHandler", () => {
  let tmpDist: string;
  const indexHtml = "<!doctype html><title>claw</title>";
  const appJs = "console.log('hi');";

  beforeAll(async () => {
    tmpDist = await mkdtemp(path.join(tmpdir(), "clawchannel-dist-"));
    await writeFile(path.join(tmpDist, "index.html"), indexHtml);
    await mkdir(path.join(tmpDist, "assets"));
    await writeFile(path.join(tmpDist, "assets", "app.js"), appJs);
    // An empty subdir so a directory request can be exercised.
    await mkdir(path.join(tmpDist, "empty"));
  });

  afterAll(async () => {
    await rm(tmpDist, { recursive: true, force: true });
  });

  it("serves index.html at the prefix root with text/html", async () => {
    const handler = createStaticAssetsHandler(tmpDist);
    const res = makeRes();
    const handled = await handler(
      makeReq("/clawchannel/"),
      res as unknown as ServerResponse,
    );
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).toString("utf8")).toBe(indexHtml);
  });

  it("serves a nested asset with the correct content type", async () => {
    const handler = createStaticAssetsHandler(tmpDist);
    const res = makeRes();
    await handler(
      makeReq("/clawchannel/assets/app.js"),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect((res.body as Buffer).toString("utf8")).toBe(appJs);
  });

  it("returns 404 for a missing file", async () => {
    const handler = createStaticAssetsHandler(tmpDist);
    const res = makeRes();
    await handler(
      makeReq("/clawchannel/assets/nope.js"),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 (not 500) for a directory request", async () => {
    // Fix 2: reading a directory throws EISDIR, which must map to 404.
    const handler = createStaticAssetsHandler(tmpDist);
    const res = makeRes();
    await handler(
      makeReq("/clawchannel/assets"),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it("never serves a traversal target outside dist", async () => {
    const handler = createStaticAssetsHandler(tmpDist);
    const res = makeRes();
    await handler(
      makeReq("/clawchannel/../../etc/passwd"),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).not.toBe(200);
    expect([403, 404]).toContain(res.statusCode);
  });
});
