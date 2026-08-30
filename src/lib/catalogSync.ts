import { listRecordings, syncCatalogDelta, type DeltaScope } from "./api";
import type { Recording } from "../types";

export const FOCUS_DEBOUNCE_MS = 300;
export const PERIODIC_INTERVAL_MS = 60_000;
export const MIN_SYNC_INTERVAL_MS = 30_000;

export type CatalogView = "session" | "library";

export function resolveScopeForView(view: CatalogView): DeltaScope {
  return view === "session" ? { kind: "last24h" } : { kind: "full" };
}

export interface CatalogSyncOptions {
  onRecordings: (recordings: Recording[]) => void;
  onListSyncing: (syncing: boolean) => void;
  isScanBusy: () => boolean;
}

export interface SyncRequest {
  scope: DeltaScope;
  immediate?: boolean;
}

export function createCatalogSync(options: CatalogSyncOptions) {
  let inFlight: Promise<void> | null = null;
  let lastSyncAt = 0;
  let generation = 0;

  async function refreshList(activeGeneration: number) {
    const list = await listRecordings();
    if (activeGeneration === generation) {
      options.onRecordings(list);
    }
  }

  function sync(request: SyncRequest): Promise<void> {
    const { scope, immediate = false } = request;
    const now = Date.now();

    if (!immediate && now - lastSyncAt < MIN_SYNC_INTERVAL_MS) {
      const activeGeneration = generation;
      options.onListSyncing(true);
      return refreshList(activeGeneration).finally(() => {
        if (activeGeneration === generation) {
          options.onListSyncing(false);
        }
      });
    }

    if (inFlight) {
      return inFlight;
    }

    const activeGeneration = ++generation;
    options.onListSyncing(true);

    inFlight = (async () => {
      try {
        await refreshList(activeGeneration);
        if (activeGeneration !== generation) {
          return;
        }
        if (!options.isScanBusy()) {
          try {
            await syncCatalogDelta(scope);
            lastSyncAt = Date.now();
          } catch {
            /* scan may fail or be deduped server-side */
          }
        }
      } finally {
        if (activeGeneration === generation) {
          options.onListSyncing(false);
        }
        inFlight = null;
      }
    })();

    return inFlight;
  }

  function invalidate() {
    generation += 1;
    lastSyncAt = 0;
  }

  function markSyncFinished() {
    lastSyncAt = Date.now();
  }

  return { sync, invalidate, markSyncFinished };
}
