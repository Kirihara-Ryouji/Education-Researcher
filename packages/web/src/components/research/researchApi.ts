import type {
  ResearchAnalysisRunStatus, ResearchExecutionLinkStatus, ResearchExecutionTarget, ResearchProject,
  ResearchStudy, ResearchTableProfile, ResearchTextView, ResearchReportStatus, Session, TaskRecord, TraceGraphViewV2,
} from "@brainpilot/protocol";
export type { ResearchAnalysisRunStatus, ResearchTableProfile } from "@brainpilot/protocol";

async function request<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(`/api/research${path}`, {
    method: input === undefined ? "GET" : "POST",
    credentials: "include",
    headers: input === undefined ? undefined : { "content-type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const payload = await response.json().catch(() => ({})) as { error?: string; details?: Array<{ path: Array<string | number>; message: string }> };
  if (!response.ok) {
    const detail = payload.details?.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(detail || payload.error || `Request failed (${response.status})`);
  }
  return payload as T;
}

async function runtimeRequest<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: "include" });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload as T;
}

export const researchApi = {
  listProjects: () => request<{ projects: ResearchProject[] }>("/projects"),
  createProject: (input: unknown) => request<ResearchProject>("/projects", input),
  getProject: (id: string) => request<{ project: ResearchProject; studies: ResearchStudy[] }>(`/projects/${encodeURIComponent(id)}`),
  createStudy: (projectId: string, input: unknown) => request<ResearchStudy>(`/projects/${encodeURIComponent(projectId)}/studies`, input),
  getStudy: (id: string) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}`),
  reviseStudy: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/specs`, input),
  addSource: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/sources`, input),
  uploadAsset: async (studyId: string, sourceId: string, file: File, accessNote: string): Promise<ResearchStudy> => {
    const response = await fetch(`/api/research/studies/${encodeURIComponent(studyId)}/sources/${encodeURIComponent(sourceId)}/assets`, {
      method: "POST", credentials: "include",
      headers: {
        "content-type": "application/octet-stream",
        "x-bp-filename": encodeURIComponent(file.name),
        "x-bp-access-note": encodeURIComponent(accessNote),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({})) as ResearchStudy & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  },
  uploadTableAsset: async (studyId: string, sourceId: string, file: File, accessNote: string): Promise<ResearchStudy> => {
    const response = await fetch(`/api/research/studies/${encodeURIComponent(studyId)}/sources/${encodeURIComponent(sourceId)}/table-assets`, {
      method: "POST", credentials: "include",
      headers: {
        "content-type": "application/octet-stream",
        "x-bp-filename": encodeURIComponent(file.name),
        "x-bp-access-note": encodeURIComponent(accessNote),
      },
      body: file,
    });
    const payload = await response.json().catch(() => ({})) as ResearchStudy & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  },
  getTableProfile: (studyId: string, assetId: string) =>
    request<ResearchTableProfile>(`/studies/${encodeURIComponent(studyId)}/assets/${encodeURIComponent(assetId)}/table-profile`),
  addCleaningRun: (studyId: string, input: unknown) =>
    request<ResearchStudy>(`/studies/${encodeURIComponent(studyId)}/cleaning-runs`, input),
  addAnalysisRun: (studyId: string, input: { cleaningRunId: string }) =>
    request<ResearchStudy>(`/studies/${encodeURIComponent(studyId)}/analysis-runs`, input),
  getAnalysisRunStatuses: (studyId: string) =>
    request<{ statuses: ResearchAnalysisRunStatus[] }>(`/studies/${encodeURIComponent(studyId)}/analysis-runs/status`),
  addReport: (studyId: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(studyId)}/reports`, input),
  getReportStatuses: (studyId: string) => request<{ statuses: ResearchReportStatus[] }>(`/studies/${encodeURIComponent(studyId)}/reports/status`),
  reportDownloadUrl: (studyId: string, reportId: string) => `/api/research/studies/${encodeURIComponent(studyId)}/reports/${encodeURIComponent(reportId)}/download`,
  reportManifestUrl: (studyId: string, reportId: string) => `/api/research/studies/${encodeURIComponent(studyId)}/reports/${encodeURIComponent(reportId)}/manifest`,
  assetDownloadUrl: (studyId: string, assetId: string) => `/api/research/studies/${encodeURIComponent(studyId)}/assets/${encodeURIComponent(assetId)}/download`,
  assetViewUrl: (studyId: string, assetId: string) => `/api/research/studies/${encodeURIComponent(studyId)}/assets/${encodeURIComponent(assetId)}/view`,
  getAssetText: (studyId: string, assetId: string, section: number) => request<ResearchTextView>(`/studies/${encodeURIComponent(studyId)}/assets/${encodeURIComponent(assetId)}/text?section=${section}`),
  addEvidenceFromAsset: (studyId: string, input: { assetId: string; section: number; segmentIndex: number; start?: number; end?: number }) => request<ResearchStudy>(`/studies/${encodeURIComponent(studyId)}/evidence/from-asset`, input),
  addManualPageEvidence: (studyId: string, input: { assetId: string; page: number; content: string; note: string }) => request<ResearchStudy>(`/studies/${encodeURIComponent(studyId)}/evidence/manual-page`, input),
  addEvidence: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/evidence`, input),
  verifyEvidence: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/verifications`, input),
  addPlan: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/plans`, input),
  addExecutionLink: (id: string, input: { planVersionId: string; sessionId: string; target: ResearchExecutionTarget; note: string }) =>
    request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/execution-links`, input),
  getExecutionLinkStatuses: (id: string) => request<{ statuses: ResearchExecutionLinkStatus[] }>(`/studies/${encodeURIComponent(id)}/execution-links/status`),
  listSessions: () => runtimeRequest<{ sessions: Session[] }>("/sessions"),
  listSessionTasks: (sessionId: string) => runtimeRequest<{ tasks: TaskRecord[] }>(`/sessions/${encodeURIComponent(sessionId)}/tasks`),
  getSessionTrace: (sessionId: string) => runtimeRequest<TraceGraphViewV2>(`/sessions/${encodeURIComponent(sessionId)}/trace`),
  addClaim: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/claims`, input),
  decide: (id: string, input: unknown) => request<ResearchStudy>(`/studies/${encodeURIComponent(id)}/decisions`, input),
};
