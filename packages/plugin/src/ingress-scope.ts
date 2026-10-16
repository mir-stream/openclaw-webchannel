import { deriveStorageNamespaceId, type StorageScopeIdentity } from "./storage-identity.js";
import { createPersistentDedupe, type PersistentDedupe, type PersistentDedupeOptions } from "openclaw/plugin-sdk/persistent-dedupe";

const SCOPED_NAMESPACE_PREFIX = "tenant:";

/** Production uses the exact storage tuple. Strings address pre-tenant callers. */
export type IngressScope = StorageScopeIdentity | string;

/** A storage namespace, never a wire account ID or a routing destination. */
export function ingressScopeNamespace(scope: IngressScope): string {
  // Distinct durable namespaces; SDK memory also needs separation below.
  return typeof scope === "string" ? scope : `${SCOPED_NAMESPACE_PREFIX}${deriveStorageNamespaceId(scope)}`;
}

/** Preserve persisted keys while separating the SDK's delimiter-based caches. */
export function createIngressScopeDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  // The SDK caches `${namespace}:${key}`. A legacy account "tenant" with key
  // "v2_<hash>:peer:id" aliases scoped namespace "tenant:v2_<hash>", key
  // "peer:id". Independent instances isolate both memory and in-flight writes.
  const scoped = createPersistentDedupe(options);
  // Production only probes legacy membership. Avoid a second retained cache
  // while preserving the SDK's original durable namespace, TTL and error hooks.
  const legacy = createPersistentDedupe({ ...options, memoryMaxSize: 0 });
  const storeFor = (namespace?: string) => namespace?.trim().startsWith(SCOPED_NAMESPACE_PREFIX)
    ? scoped : legacy;
  return {
    checkAndRecord: (key, checkOptions) => storeFor(checkOptions?.namespace).checkAndRecord(key, checkOptions),
    hasRecent: (key, checkOptions) => storeFor(checkOptions?.namespace).hasRecent(key, checkOptions),
    forget: (key, checkOptions) => storeFor(checkOptions?.namespace).forget(key, checkOptions),
    warmup: (namespace, onError) => storeFor(namespace).warmup(namespace, onError),
    clearMemory: () => { scoped.clearMemory(); legacy.clearMemory(); },
    memorySize: () => scoped.memorySize() + legacy.memorySize(),
  };
}
