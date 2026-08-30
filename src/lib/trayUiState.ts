import type { JobStatus, ViewId } from "../types";

export const HOME_VIEW: Exclude<ViewId, "editor"> = "session";

export interface TrayPurgePatch {
  editJobs: JobStatus[];
  previewJobs: JobStatus[];
}

export function trayPurgePatch(): TrayPurgePatch {
  return {
    editJobs: [],
    previewJobs: [],
  };
}
