import { ConversationKeyStore } from "../conversation-key-store.js";

const [home, tenant, accountId, peerId] = process.argv.slice(2);
if (!home || !tenant || !accountId || !peerId) {
  process.exitCode = 2;
} else {
  const store = new ConversationKeyStore({
    home,
    tenant,
    accountId,
  });
  process.stdout.write(
    Buffer.from(store.getOrCreate(peerId)).toString("base64url"),
  );
}
