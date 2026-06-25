import { defineConfig } from 'vitest/config'

// Root vitest config — runs the webchannel workspace test suites.
export default defineConfig({
  test: {
    // Isolate each test file in its own forked process. The port-scan tests in
    // nats-transport.test.ts count LISTEN sockets for the worker PID, so a
    // sibling file opening an in-process WebSocketServer in the SAME worker
    // would corrupt the delta. Per-file forks keep that measurement clean.
    pool: 'forks',
    isolate: true,
  },
})
