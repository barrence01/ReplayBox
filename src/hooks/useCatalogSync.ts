import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeltaScope } from "../lib/api";
import {
  createCatalogSync,
  FOCUS_DEBOUNCE_MS,
  PERIODIC_INTERVAL_MS,
  resolveScopeForView,
  type CatalogView,
  type SyncRequest,
} from "../lib/catalogSync";
import type { Recording, ViewId } from "../types";

interface Options {
  view: ViewId;
  watchDir: string | null;
  onRecordings: (recordings: Recording[]) => void;
  deltaSyncing: boolean;
  fullScanning: boolean;
  trayHidden: boolean;
  onPersistCache: (recordings: Recording[]) => void;
}

export function useCatalogSync({
  view,
  watchDir,
  onRecordings,
  deltaSyncing,
  fullScanning,
  trayHidden,
  onPersistCache,
}: Options) {
  const [listSyncing, setListSyncing] = useState(false);
  const scanBusyRef = useRef(false);
  const viewRef = useRef(view);
  const trayHiddenRef = useRef(trayHidden);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    trayHiddenRef.current = trayHidden;
  }, [trayHidden]);

  useEffect(() => {
    scanBusyRef.current = deltaSyncing || fullScanning;
  }, [deltaSyncing, fullScanning]);

  const onRecordingsRef = useRef(onRecordings);
  useEffect(() => {
    onRecordingsRef.current = onRecordings;
  }, [onRecordings]);

  const onPersistCacheRef = useRef(onPersistCache);
  useEffect(() => {
    onPersistCacheRef.current = onPersistCache;
  }, [onPersistCache]);

  const catalogSyncRef = useRef(
    createCatalogSync({
      onRecordings: (recordings) => {
        onRecordingsRef.current(recordings);
        if (watchDir) {
          onPersistCacheRef.current(recordings);
        }
      },
      onListSyncing: setListSyncing,
      isScanBusy: () => scanBusyRef.current,
    }),
  );

  useEffect(() => {
    catalogSyncRef.current.invalidate();
  }, [watchDir]);

  const syncCatalog = useCallback((request: SyncRequest) => {
    return catalogSyncRef.current.sync(request);
  }, []);

  const markSyncFinished = useCallback(() => {
    catalogSyncRef.current.markSyncFinished();
  }, []);

  const isCatalogView = (v: ViewId): v is CatalogView =>
    v === "session" || v === "library";

  useEffect(() => {
    if (!isCatalogView(view)) {
      return;
    }
    void syncCatalog({ scope: resolveScopeForView(view), immediate: true });
  }, [view, syncCatalog]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let debounceId: number | null = null;

    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (!focused || trayHiddenRef.current) {
          return;
        }
        const currentView = viewRef.current;
        if (!isCatalogView(currentView)) {
          return;
        }
        if (debounceId !== null) {
          window.clearTimeout(debounceId);
        }
        debounceId = window.setTimeout(() => {
          debounceId = null;
          void syncCatalog({
            scope: resolveScopeForView(currentView),
            immediate: true,
          });
        }, FOCUS_DEBOUNCE_MS);
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      unlisten?.();
      if (debounceId !== null) {
        window.clearTimeout(debounceId);
      }
    };
  }, [syncCatalog]);

  useEffect(() => {
    if (trayHidden) {
      return;
    }
    if (!isCatalogView(view)) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (trayHiddenRef.current) {
        return;
      }
      const currentView = viewRef.current;
      if (!isCatalogView(currentView)) {
        return;
      }
      void syncCatalog({
        scope: resolveScopeForView(currentView),
        immediate: false,
      });
    }, PERIODIC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [view, trayHidden, syncCatalog]);

  const syncFromTray = useCallback(() => {
    void syncCatalog({ scope: { kind: "full" }, immediate: true });
  }, [syncCatalog]);

  const syncFolder = useCallback(
    (folderPath: string) => {
      const scope: DeltaScope = { kind: "folder", folderPath };
      void syncCatalog({ scope, immediate: true });
    },
    [syncCatalog],
  );

  return {
    catalogSyncing: listSyncing || deltaSyncing || fullScanning,
    syncCatalog,
    syncFromTray,
    syncFolder,
    markSyncFinished,
  };
}
