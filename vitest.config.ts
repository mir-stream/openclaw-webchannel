import { defineConfig, configDefaults } from 'vitest/config'

// Root vitest config — runs the webchannel workspace test suites.
export default defineConfig({
  test: {
    // `docker/plugin/` is a standalone COPY of packages/plugin used for the
    // container `--link` install (gitignored build artifact). It ships its own
    // *.test.ts, which vitest would otherwise double-collect — inflating the
    // suite and racing the real-nats-server tests against their originals. Never
    // treat the copy as a test surface.
    //
    // `examples/**` are CONSUMER tests: plain `node` (node:test/TAP) scripts
    // that import @mir-stream/* by package ENTRY (dist/), run via each
    // example's own `npm test`. Under vitest they both need a pre-built dist
    // AND assert node-resolver error codes vite doesn't produce
    // (ERR_PACKAGE_PATH_NOT_EXPORTED) — so vitest must not collect them. The
    // e2e-gate workflow runs them explicitly after building dist.
    exclude: [...configDefaults.exclude, 'docker/**', 'examples/**'],
    // Isolate each test file in its own forked process. The port-scan tests in
    // nats-transport.test.ts count LISTEN sockets for the worker PID, so a
    // sibling file opening an in-process WebSocketServer in the SAME worker
    // would corrupt the delta. Per-file forks keep that measurement clean.
    pool: 'forks',
    isolate: true,
  },
})
