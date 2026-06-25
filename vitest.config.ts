import { defineConfig, defaultExclude } from 'vitest/config'

// Root vitest config. `references/` holds a vendored reference checkout
// (openclaw) that is NOT part of this project's test suite — exclude it so
// `npm test` at the repo root only runs the webchannel workspaces.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, 'references/**'],
    // Isolate each test file in its own forked process. The port-scan tests in
    // nats-transport.test.ts count LISTEN sockets for the worker PID, so a
    // sibling file opening an in-process WebSocketServer in the SAME worker
    // would corrupt the delta. Per-file forks keep that measurement clean.
    pool: 'forks',
    isolate: true,
  },
})
