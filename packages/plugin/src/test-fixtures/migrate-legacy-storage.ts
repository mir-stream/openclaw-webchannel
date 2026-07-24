import { migrateLegacyTupleState } from "../legacy-storage-migration.js";

const [home, tenant, accountId, delayText] = process.argv.slice(2);
if (!home || !tenant || !accountId) {
  process.exitCode = 2;
} else {
  const delayMs = Number(delayText ?? "0");
  try {
    const result = migrateLegacyTupleState({
      home,
      tenant,
      accountId,
      ...(delayMs > 0
        ? {
            _afterClaim: () => {
              Atomics.wait(
                new Int32Array(new SharedArrayBuffer(4)),
                0,
                0,
                delayMs,
              );
            },
          }
        : {}),
    });
    process.stdout.write(JSON.stringify({ ok: true, status: result.status }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        code:
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "unknown",
      }),
    );
  }
}
