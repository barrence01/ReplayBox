import type { JobStatus, Recording, ViewId } from "../types";

export const HOME_VIEW: Exclude<ViewId, "editor"> = "session";

export interface TrayPurgePatch {
  libraryReady: false;
  recordings: Recording[];
  editJobs: JobStatus[];
  previewJobs: JobStatus[];
}

export function trayPurgePatch(): TrayPurgePatch {
  return {
    libraryReady: false,
    recordings: [],
    editJobs: [],
    previewJobs: [],
  };
}
