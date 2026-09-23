import { deriveStorageNamespaceId, type StorageScopeIdentity } from "./storage-identity.js";

/** Production uses the exact storage tuple. Strings address pre-tenant callers. */
export type IngressScope = StorageScopeIdentity | string;

/** A storage namespace, never a wire account ID or a routing destination. */
export function ingressScopeNamespace(scope: IngressScope): string {
  // ':' is forbidden in account IDs, so no legacy account can alias this role.
  return typeof scope === "string" ? scope : `tenant:${deriveStorageNamespaceId(scope)}`;
}
