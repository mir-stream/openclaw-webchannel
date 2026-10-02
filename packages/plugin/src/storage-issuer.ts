import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWritePrivateFile } from "./private-file.js";
import { legacyTuplePaths, tupleStoragePaths, type TupleStoragePathOptions } from "./storage-paths.js";

const STORAGE_ISSUER_FILE = "storage-issuer.json";
type IssuerScope = TupleStoragePathOptions & { issuer: string };

/** The issuer is the same slash-insensitive identity accepted by verifyJwt. */
function canonicalIssuer(issuer: string): string {
  const value = issuer.replace(/\/+$/, "");
  if (!value) throw new Error("webchannel: storage issuer is empty");
  return value;
}

export class StorageIssuerError extends Error {
  readonly fix: string;
  constructor(scope: TupleStoragePathOptions, reason: string) {
    const paths = tupleStoragePaths(scope);
    const legacy = legacyTuplePaths(scope.accountId, scope.home);
    const fix = `Stop all gateways serving this account. Restore the original issuer, or archive the complete tuple directory ${JSON.stringify(paths.directory)} ` +
      `(history, conversation keys and storage-issuer.json together), and any live legacy state at ${JSON.stringify(legacy.directory)}. ` +
      `Then explicitly initialize fresh state by re-enrolling account ${JSON.stringify(scope.accountId)} and starting it with the intended issuer. ` +
      "Keep the archive offline; never copy old history or keys into the new tuple or edit the issuer marker to relabel them.";
    super(`webchannel: storage issuer ${reason}; account start refused. ${fix}`);
    this.name = "StorageIssuerError";
    this.fix = fix;
  }
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Read-only gate shared by runtime auth preparation and doctor. */
export function inspectStorageIssuer(scope: IssuerScope): "fresh" | "match" {
  const paths = tupleStoragePaths(scope);
  const issuer = canonicalIssuer(scope.issuer);
  // A later lazy key read can import legacy state. It has no issuer proof and
  // must not be silently adopted even when the new tuple is otherwise empty.
  if (present(legacyTuplePaths(scope.accountId, scope.home).conversationKeyPath)) {
    throw new StorageIssuerError(scope, "unbound legacy state");
  }
  const marker = join(paths.directory, STORAGE_ISSUER_FILE);
  if (!present(marker)) {
    const data = [paths.conversationKeyPath, paths.conversationKeyGenerationsPath,
      paths.deliveryJournalPath, `${paths.deliveryJournalPath}-wal`, `${paths.deliveryJournalPath}-shm`, `${paths.deliveryJournalPath}-journal`];
    if (data.some(present)) throw new StorageIssuerError(scope, "unbound state");
    return "fresh";
  }
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(marker, "utf8"));
    if (!value || value.version !== 1 || typeof value.issuer !== "string" ||
        value.tenant !== scope.tenant || value.accountId !== scope.accountId) throw new Error("metadata");
  } catch {
    throw new StorageIssuerError(scope, "invalid or unsupported metadata");
  }
  if (value.issuer !== issuer) throw new StorageIssuerError(scope, "mismatch");
  return "match";
}

/** Bind only an empty tuple, atomically and without replacing an existing owner. */
export function ensureStorageIssuer(scope: IssuerScope): void {
  if (inspectStorageIssuer(scope) === "match") return;
  const paths = tupleStoragePaths(scope);
  try {
    atomicWritePrivateFile(join(paths.directory, STORAGE_ISSUER_FILE), JSON.stringify({
      version: 1, tenant: scope.tenant, accountId: scope.accountId, issuer: canonicalIssuer(scope.issuer),
    }) + "\n", { replace: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // A concurrent initializer can win the no-overwrite publish with another
  // issuer. Its marker is authoritative; never return before checking it.
  inspectStorageIssuer(scope);
}
