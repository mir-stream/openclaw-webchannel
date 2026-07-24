import { tupleStoragePaths } from "../packages/plugin/src/storage-paths.js";

const [kind, tenant, accountId, home] = process.argv.slice(2);

if (
  (kind !== "credentials" && kind !== "conversation-keys") ||
  tenant === undefined ||
  accountId === undefined ||
  home === undefined
) {
  console.error(
    "usage: resolve-storage-path.ts <credentials|conversation-keys> <tenant> <accountId> <home>",
  );
  process.exit(2);
}

const paths = tupleStoragePaths({ tenant, accountId, home });
process.stdout.write(
  kind === "credentials"
    ? paths.credentialPath
    : paths.conversationKeyPath,
);
