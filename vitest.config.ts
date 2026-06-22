import { defineConfig, defaultExclude } from 'vitest/config'

// Root vitest config. `references/` holds a vendored reference checkout
// (openclaw) that is NOT part of this project's test suite — exclude it so
// `npm test` at the repo root only runs the webchannel workspaces.
export default defineConfig({
  test: {
    exclude: [...defaultExclude, 'references/**'],
  },
})
