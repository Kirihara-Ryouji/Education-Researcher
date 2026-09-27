import { useEffect, useState, type FormEvent } from "react";
import { executionLinkReviewReasons, type ResearchExecutionLink, type ResearchExecutionLinkStatus, type ResearchExecutionTarget, type ResearchStudy, type Session, type TaskRecord, type TraceGraphViewV2 } from "@brainpilot/protocol";
import { useT } from "../../i18n/useT";
import { researchApi } from "./researchApi";

type Candidate = { key: string; label: string; target: ResearchExecutionTarget };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function executionLinkStatus(study: ResearchStudy, link: ResearchExecutionLink, statuses: ResearchExecutionLinkStatus[], statusError = ""): ResearchExecutionLinkStatus | undefined {
  const remote = statuses.find((item) => item.linkId === link.id);
  const local = executionLinkReviewReasons(study, link);
  if (!remote && statusError) return { linkId: link.id, status: "unavailable", reasons: [...new Set([...local, "runtime_unavailable" as const])] };
  if (!remote) return local.length ? { linkId: link.id, status: "needs_review", reasons: local } : undefined;
  const reasons = [...new Set([...local, ...remote.reasons])];
  return { ...remote, status: remote.status === "current" && reasons.length > 0 ? "needs_review" : remote.status, reasons };
}

export function ExecutionLinkSummary({ study, link, statuses, statusError = "" }: {
  study: ResearchStudy;
  link: ResearchExecutionLink;
  statuses: ResearchExecutionLinkStatus[];
  statusError?: string;
}) {
  const t = useT();
  const plan = study.plans.find((item) => item.id === link.planVersionId);
  const status = executionLinkStatus(study, link, statuses, statusError);
  return <div className="research-workspace__execution-summary">
    <strong>{link.snapshot.targetLabel}</strong>
    <span className="research-workspace__muted">{t(`research.executionTarget_${link.target.kind}`)} · {link.snapshot.sessionTitle} · {t("research.executionPlanVersion", { version: plan?.version ?? "?" })}</span>
    <span className="research-workspace__muted">{t("research.executionTargetId")}: {link.target.kind === "session" ? link.sessionId : link.target.id} · {link.createdAt}</span>
    {link.note && <p>{link.note}</p>}
    <p className="research-workspace__muted">{t("research.executionSnapshot")}: {link.snapshot.fingerprint.slice(0, 12)}…{link.snapshot.contentHash ? ` · ${t("research.executionContentHash")}: ${link.snapshot.contentHash.slice(0, 16)}…` : ""}{link.snapshot.traceRevision !== undefined ? ` · ${t("research.executionTraceRevision", { revision: link.snapshot.traceRevision })}` : ""}</p>
    <p className={status?.status === "current" ? "research-workspace__muted" : "research-workspace__warning"}>
      {t(status ? `research.executionStatus_${status.status}` : "research.executionStatus_checking")}
      {status?.reasons.length ? ` · ${status.reasons.map((reason) => t(`research.executionReason_${reason}`)).join("; ")}` : ""}
    </p>
  </div>;
}

export function ResearchExecutionLinks({ study, planVersionId, canLink, statuses, statusError, busy, onAdd, onRefresh }: {
  study: ResearchStudy;
  planVersionId?: string;
  canLink: boolean;
  statuses: ResearchExecutionLinkStatus[];
  statusError: string;
  busy: boolean;
  onAdd: (input: { planVersionId: string; sessionId: string; target: ResearchExecutionTarget; note: string }) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [trace, setTrace] = useState<TraceGraphViewV2 | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [targetKey, setTargetKey] = useState("session");

  useEffect(() => {
    if (!canLink) return;
    let active = true;
    researchApi.listSessions().then(({ sessions: records }) => {
      if (!active) return;
      setSessions(records);
      setSessionId((current) => records.some((item) => item.id === current) ? current : records[0]?.id ?? "");
      setCandidateError("");
    }).catch((cause: unknown) => { if (active) setCandidateError(errorMessage(cause)); });
    return () => { active = false; };
  }, [canLink]);

  useEffect(() => {
    setTasks([]);
    setTrace(null);
    setTargetKey("session");
    if (!canLink || !sessionId) return;
    let active = true;
    setLoadingCandidates(true);
    Promise.allSettled([researchApi.listSessionTasks(sessionId), researchApi.getSessionTrace(sessionId)]).then(([tasksResult, traceResult]) => {
      if (!active) return;
      if (tasksResult.status === "fulfilled") setTasks(tasksResult.value.tasks);
      if (traceResult.status === "fulfilled") setTrace(traceResult.value);
      const errors = [tasksResult, traceResult].filter((result) => result.status === "rejected").map((result) => errorMessage(result.reason));
      setCandidateError(errors.join("; "));
    }).finally(() => { if (active) setLoadingCandidates(false); });
    return () => { active = false; };
  }, [canLink, sessionId]);

  const selectedSession = sessions.find((item) => item.id === sessionId);
  const eligibleNodes = (trace?.nodes ?? []).filter((node) => node.id !== trace?.meta.rootNodeId && !node.revoked);
  const eligibleProducerNodeIds = new Set(eligibleNodes.map((node) => node.id));
  const eligibleArtifacts = (trace?.artifacts ?? []).filter((artifact) =>
    artifact.role === "output" && artifact.exists === "present" && artifact.verificationStatus === "verified"
    && (!artifact.producerNodeId || eligibleProducerNodeIds.has(artifact.producerNodeId)));
  const candidates: Candidate[] = [{ key: "session", label: t("research.executionTarget_session"), target: { kind: "session" } }];
  for (const task of tasks) candidates.push({
    key: `task:${task.id}`,
    label: `${task.content.slice(0, 100)} · ${t(`research.executionTask_${task.status}`)} · ${task.id}`,
    target: { kind: "task", id: task.id },
  });
  for (const node of eligibleNodes) candidates.push({
    key: `trace_node:${node.id}`,
    label: `${node.title} · ${node.status} · ${node.id}`,
    target: { kind: "trace_node", id: node.id },
  });
  for (const artifact of eligibleArtifacts) candidates.push({
    key: `trace_artifact:${artifact.id}`,
    label: `${artifact.path} · ${artifact.verificationStatus} · ${artifact.id}`,
    target: { kind: "trace_artifact", id: artifact.id },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canLink || !planVersionId || !sessionId) return;
    const form = event.currentTarget;
    const selected = candidates.find((item) => item.key === targetKey);
    if (!selected) return;
    const note = String(new FormData(form).get("note") ?? "").trim();
    void onAdd({ planVersionId, sessionId, target: selected.target, note }).then((success) => { if (success) form.reset(); });
  };

  return <section className="research-workspace__card">
    <div className="research-workspace__section-head"><h2>{t("research.executionLinks")}</h2><button className="research-workspace__text-button" type="button" disabled={busy} onClick={onRefresh}>{t("research.refreshExecutionStatus")}</button></div>
    <p className="research-workspace__muted">{t("research.executionHelp")}</p>
    {study.executionLinks.length === 0 && <p className="research-workspace__muted">{t("research.noExecutionLinks")}</p>}
    <ol className="research-workspace__execution-links">{study.executionLinks.map((link) => <li key={link.id}><ExecutionLinkSummary study={study} link={link} statuses={statuses} statusError={statusError} /></li>)}</ol>
    {statusError && <p className="research-workspace__warning">{t("research.executionStatusUnavailable", { message: statusError })}</p>}
    {!canLink && <p className="research-workspace__muted">{t("research.executionRequiresPlan")}</p>}
    {canLink && <form onSubmit={submit}>
      <label>{t("research.executionSession")}
        <select value={sessionId} onChange={(event) => setSessionId(event.target.value)} required>
          {sessions.length === 0 && <option value="">{t("research.noExecutionSessions")}</option>}
          {sessions.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.id}</option>)}
        </select>
      </label>
      {selectedSession && <p className="research-workspace__muted">{t("research.executionSessionId")}: {selectedSession.id}</p>}
      <label>{t("research.executionTarget")}
        <select value={candidates.some((item) => item.key === targetKey) ? targetKey : "session"} onChange={(event) => setTargetKey(event.target.value)}>
          <option value="session">{t("research.executionTarget_session")}</option>
          {tasks.length > 0 && <optgroup label={t("research.executionTarget_task")}>{tasks.map((task) => <option key={task.id} value={`task:${task.id}`}>{task.content.slice(0, 100)} · {t(`research.executionTask_${task.status}`)} · {task.id}</option>)}</optgroup>}
          {eligibleNodes.length > 0 && <optgroup label={t("research.executionTarget_trace_node")}>{eligibleNodes.map((node) => <option key={node.id} value={`trace_node:${node.id}`}>{node.title} · {node.status} · {node.id}</option>)}</optgroup>}
          {eligibleArtifacts.length > 0 && <optgroup label={t("research.executionTarget_trace_artifact")}>{eligibleArtifacts.map((artifact) => <option key={artifact.id} value={`trace_artifact:${artifact.id}`}>{artifact.path} · {artifact.verificationStatus} · {artifact.id}</option>)}</optgroup>}
        </select>
      </label>
      {loadingCandidates && <p className="research-workspace__muted">{t("research.loadingExecutionTargets")}</p>}
      {candidateError && <p className="research-workspace__warning">{t("research.executionCandidatesUnavailable", { message: candidateError })}</p>}
      <label>{t("research.executionNote")}<textarea name="note" rows={2} maxLength={2000} /></label>
      <button type="submit" disabled={busy || !sessionId}>{t("research.addExecutionLink")}</button>
    </form>}
  </section>;
}
