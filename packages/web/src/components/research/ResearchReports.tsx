import { useEffect, useState, type FormEvent } from "react";
import { staleEvidenceIds, type ResearchAnalysisRunStatus, type ResearchExecutionLinkStatus, type ResearchReportStatus, type ResearchReportVersion, type ResearchStudy } from "@brainpilot/protocol";
import { useT } from "../../i18n/useT";
import { analysisRunStatus } from "./ResearchDataAnalysis";
import { executionLinkStatus } from "./ResearchExecutionLinks";
import { researchApi } from "./researchApi";

type SectionDraft = { heading: string; content: string };
type ReportDraft = {
  baseId: string;
  title: string;
  summary: string;
  sections: SectionDraft[];
  limitations: string[];
  claimIds: string[];
  analysisRunIds: string[];
  reason: string;
};

function blankDraft(): ReportDraft {
  return { baseId: "", title: "", summary: "", sections: [{ heading: "", content: "" }], limitations: [""], claimIds: [], analysisRunIds: [], reason: "" };
}

function draftFromReport(report: ResearchReportVersion): ReportDraft {
  return {
    baseId: report.id,
    title: report.title,
    summary: report.summary,
    sections: report.sections.map((section) => ({ ...section })),
    limitations: [...report.limitations],
    claimIds: [...report.claimIds],
    analysisRunIds: [...report.analysisRunIds],
    reason: "",
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ResearchReports({ study, busy, analysisStatuses, analysisStatusError, executionStatuses, executionStatusError, onMutate }: {
  study: ResearchStudy;
  busy: boolean;
  analysisStatuses: ResearchAnalysisRunStatus[];
  analysisStatusError: string;
  executionStatuses: ResearchExecutionLinkStatus[];
  executionStatusError: string;
  onMutate: (action: () => Promise<ResearchStudy>) => Promise<boolean>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ReportDraft>(blankDraft);
  const [statuses, setStatuses] = useState<ResearchReportStatus[]>([]);
  const [statusError, setStatusError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!study.reports.length) { setStatuses([]); setStatusError(""); return; }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await researchApi.getReportStatuses(study.id);
        if (active) { setStatuses(result.statuses); setStatusError(""); }
      } catch (cause) {
        if (active) { setStatuses([]); setStatusError(errorMessage(cause)); }
      } finally { pending = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [study.id, study.updatedAt, study.reports.length, refreshKey]);

  const staleEvidence = staleEvidenceIds(study);
  const acceptedClaims = study.claims.filter((claim) => {
    const decision = study.decisions.find((item) => item.target === "claim" && item.targetId === claim.id);
    if (decision?.decision !== "accept" || claim.evidence.some((link) => staleEvidence.has(link.evidenceId) || !study.evidence.some((item) => item.id === link.evidenceId))) return false;
    if (claim.executionLinkIds.some((id) => {
      const link = study.executionLinks.find((item) => item.id === id);
      return !link || executionLinkStatus(study, link, executionStatuses, executionStatusError)?.status !== "current";
    })) return false;
    return !claim.analysisRunIds.some((id) => analysisRunStatus(id, analysisStatuses, analysisStatusError)?.status !== "current");
  });
  const acceptedClaimIds = new Set(acceptedClaims.map((claim) => claim.id));
  const invalidClaimIds = draft.claimIds.filter((id) => !acceptedClaimIds.has(id));
  const selectedClaims = study.claims.filter((claim) => draft.claimIds.includes(claim.id));
  const requiredAnalysisRunIds = new Set(selectedClaims.flatMap((claim) => claim.analysisRunIds));
  const selectedAnalysisRunIds = [...new Set([...draft.analysisRunIds, ...requiredAnalysisRunIds])];
  const invalidAnalysisRunIds = selectedAnalysisRunIds.filter((id) => analysisRunStatus(id, analysisStatuses, analysisStatusError)?.status !== "current");
  const currentPlan = study.plans.at(-1);
  const planAccepted = Boolean(currentPlan && currentPlan.specVersionId === study.specs.at(-1)?.id
    && !currentPlan.evidenceIds.some((id) => staleEvidence.has(id))
    && study.decisions.some((item) => item.target === "plan" && item.targetId === currentPlan.id && item.decision === "accept"));

  const setSection = (index: number, field: keyof SectionDraft, value: string) => setDraft((current) => ({
    ...current, sections: current.sections.map((section, i) => i === index ? { ...section, [field]: value } : section),
  }));
  const setLimitation = (index: number, value: string) => setDraft((current) => ({
    ...current, limitations: current.limitations.map((item, i) => i === index ? value : item),
  }));
  const toggleClaim = (id: string, checked: boolean) => setDraft((current) => ({
    ...current, claimIds: checked ? [...current.claimIds, id] : current.claimIds.filter((item) => item !== id),
  }));
  const toggleAnalysis = (id: string, checked: boolean) => setDraft((current) => ({
    ...current, analysisRunIds: checked ? [...current.analysisRunIds, id] : current.analysisRunIds.filter((item) => item !== id),
  }));

  const createReport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!planAccepted || !draft.claimIds.length || invalidClaimIds.length || invalidAnalysisRunIds.length) return;
    const input = {
      title: draft.title.trim(), summary: draft.summary.trim(),
      sections: draft.sections.map((section) => ({ heading: section.heading.trim(), content: section.content.trim() })),
      limitations: draft.limitations.map((item) => item.trim()),
      claimIds: draft.claimIds, analysisRunIds: selectedAnalysisRunIds, reason: draft.reason.trim(),
    };
    void onMutate(() => researchApi.addReport(study.id, input)).then((success) => {
      if (success) setDraft(blankDraft());
    });
  };

  const decideReport = (event: FormEvent<HTMLFormElement>, reportId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value === "return" ? "return" : "accept";
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    void onMutate(() => researchApi.decide(study.id, { target: "report", targetId: reportId, decision, reason })).then((success) => {
      if (success) form.reset();
    });
  };

  return <section className="research-workspace__card" aria-label={t("research.reports")}>
    <div className="research-workspace__section-head"><h2>{t("research.reports")}</h2><button type="button" className="research-workspace__text-button" disabled={busy} onClick={() => setRefreshKey((value) => value + 1)}>{t("research.refreshReportStatus")}</button></div>
    <p className="research-workspace__muted">{t("research.reportHelp")}</p>
    {statusError && <p className="research-workspace__warning">{t("research.reportStatusUnavailable", { message: statusError })}</p>}
    {study.reports.length === 0 && <p className="research-workspace__muted">{t("research.noReports")}</p>}
    <ol className="research-workspace__report-history">{study.reports.map((report) => {
      const status = statuses.find((item) => item.reportId === report.id) ?? (statusError ? { reportId: report.id, status: "unavailable" as const, reasons: [] } : undefined);
      const decision = study.decisions.find((item) => item.target === "report" && item.targetId === report.id);
      return <li key={report.id}>
        <div className="research-workspace__section-head"><strong>v{report.version} · {report.title}</strong><span>{report.createdAt}</span></div>
        <p>{report.summary}</p>
        <p className={status?.status === "current" ? "research-workspace__muted" : "research-workspace__warning"}>
          {t(status ? `research.reportStatus_${status.status}` : "research.reportStatus_checking")}
          {status?.reasons.length ? ` · ${status.reasons.map((reason) => t(`research.reportReason_${reason}`)).join("; ")}` : ""}
        </p>
        <p className="research-workspace__muted">{t("research.reportClaimsCount", { count: report.claimIds.length })} · {t("research.reportAnalysisCount", { count: report.analysisRunIds.length })} · SHA-256 {report.sha256.slice(0, 12)}…</p>
        {decision && <p className="research-workspace__muted">{t(decision.decision === "accept" ? "research.statusAccepted" : "research.statusReturned")} · {decision.reason}</p>}
        <div className="research-workspace__report-actions">
          <a href={researchApi.reportDownloadUrl(study.id, report.id)} download>{t("research.downloadReport")}</a>
          <a href={researchApi.reportManifestUrl(study.id, report.id)} download>{t("research.downloadReportManifest")}</a>
          <button type="button" className="research-workspace__text-button" disabled={busy} onClick={() => setDraft(draftFromReport(report))}>{t("research.reviseReport")}</button>
        </div>
        <details><summary>{t("research.reportVersionContent")}</summary>
          {report.sections.map((section, index) => <section key={`${report.id}:${index}`}><h3>{section.heading}</h3><p className="research-workspace__preserve">{section.content}</p></section>)}
          <h3>{t("research.reportLimitations")}</h3><ul>{report.limitations.map((item, index) => <li key={`${report.id}:limit:${index}`}>{item}</li>)}</ul>
          <h3>{t("research.reportClaims")}</h3><ul>{report.claimIds.map((id) => <li key={id}>{study.claims.find((item) => item.id === id)?.text ?? id}</li>)}</ul>
          {report.analysisRunIds.length > 0 && <><h3>{t("research.reportAnalysisRuns")}</h3><ul>{report.analysisRunIds.map((id) => <li key={id}>{t("research.analysisResultVersion", { version: study.analysisRuns.find((item) => item.id === id)?.version ?? "?" })} · {id}</li>)}</ul></>}
        </details>
        {!decision && report.id === study.reports.at(-1)?.id && <form className="research-workspace__decision" onSubmit={(event) => decideReport(event, report.id)}>
          <label>{t("research.decisionReason")}<input name="reason" required /></label>
          <div className="research-workspace__decision-actions"><button type="submit" value="accept" disabled={busy || status?.status !== "current"}>{t("research.accept")}</button><button type="submit" value="return" disabled={busy}>{t("research.return")}</button></div>
        </form>}
      </li>;
    })}</ol>
    <h3>{draft.baseId ? t("research.reviseReportFromVersion", { version: study.reports.find((item) => item.id === draft.baseId)?.version ?? "?" }) : t("research.createReport")}</h3>
    {!planAccepted && <p className="research-workspace__warning">{t("research.reportRequiresPlan")}</p>}
    {acceptedClaims.length === 0 && <p className="research-workspace__warning">{t("research.reportRequiresClaim")}</p>}
    <form onSubmit={createReport}>
      <label>{t("research.reportTitle")}<input required maxLength={240} value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} /></label>
      <label>{t("research.reportSummary")}<textarea required rows={3} value={draft.summary} onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))} /></label>
      <fieldset><legend>{t("research.reportSections")}</legend>{draft.sections.map((section, index) => <div className="research-workspace__report-draft-row" key={index}>
        <label>{t("research.reportSectionHeading")}<input required maxLength={240} value={section.heading} onChange={(event) => setSection(index, "heading", event.target.value)} /></label>
        <label>{t("research.reportSectionContent")}<textarea required rows={5} value={section.content} onChange={(event) => setSection(index, "content", event.target.value)} /></label>
        {draft.sections.length > 1 && <button type="button" className="research-workspace__text-button" onClick={() => setDraft((current) => ({ ...current, sections: current.sections.filter((_, i) => i !== index) }))}>{t("research.removeSection")}</button>}
      </div>)}<button type="button" className="research-workspace__text-button" disabled={draft.sections.length >= 12} onClick={() => setDraft((current) => ({ ...current, sections: [...current.sections, { heading: "", content: "" }] }))}>{t("research.addSection")}</button></fieldset>
      <fieldset><legend>{t("research.reportLimitations")}</legend>{draft.limitations.map((limitation, index) => <div className="research-workspace__report-draft-row" key={index}>
        <label>{t("research.reportLimitation")}<input required maxLength={240} value={limitation} onChange={(event) => setLimitation(index, event.target.value)} /></label>
        {draft.limitations.length > 1 && <button type="button" className="research-workspace__text-button" onClick={() => setDraft((current) => ({ ...current, limitations: current.limitations.filter((_, i) => i !== index) }))}>{t("research.removeLimitation")}</button>}
      </div>)}<button type="button" className="research-workspace__text-button" disabled={draft.limitations.length >= 50} onClick={() => setDraft((current) => ({ ...current, limitations: [...current.limitations, ""] }))}>{t("research.addLimitation")}</button></fieldset>
      <fieldset><legend>{t("research.reportClaims")}</legend>
        {acceptedClaims.length === 0 && <p className="research-workspace__muted">{t("research.noCurrentAcceptedClaims")}</p>}
        {acceptedClaims.map((claim) => <label key={claim.id}><input type="checkbox" checked={draft.claimIds.includes(claim.id)} onChange={(event) => toggleClaim(claim.id, event.target.checked)} />{claim.text}</label>)}
        {invalidClaimIds.map((id) => <label className="research-workspace__warning" key={id}><input type="checkbox" checked onChange={() => toggleClaim(id, false)} />{study.claims.find((item) => item.id === id)?.text ?? id} · {t("research.reportCitationNeedsReview")}</label>)}
      </fieldset>
      {(study.analysisRuns.length > 0 || selectedAnalysisRunIds.length > 0) && <fieldset><legend>{t("research.reportAnalysisRuns")}</legend>
        {study.analysisRuns.map((run) => {
          const required = requiredAnalysisRunIds.has(run.id);
          const status = analysisRunStatus(run.id, analysisStatuses, analysisStatusError);
          return <label key={run.id}><input type="checkbox" checked={selectedAnalysisRunIds.includes(run.id)} disabled={required || (!selectedAnalysisRunIds.includes(run.id) && status?.status !== "current")} onChange={(event) => toggleAnalysis(run.id, event.target.checked)} />
            {t("research.analysisResultVersion", { version: run.version })} · {t(status ? `research.analysisStatus_${status.status}` : "research.analysisStatus_checking")}{required ? ` · ${t("research.reportAnalysisRequiredByClaim")}` : ""}</label>;
        })}
        {selectedAnalysisRunIds.filter((id) => !study.analysisRuns.some((item) => item.id === id)).map((id) => <label className="research-workspace__warning" key={id}><input type="checkbox" checked onChange={() => toggleAnalysis(id, false)} />{id} · {t("research.reportCitationNeedsReview")}</label>)}
      </fieldset>}
      {invalidAnalysisRunIds.length > 0 && <p className="research-workspace__warning">{t("research.reportAnalysisNeedsReview")}</p>}
      <label>{t("research.reportReason")}<input maxLength={2000} value={draft.reason} onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} /></label>
      <div className="research-workspace__report-actions"><button type="submit" disabled={busy || !planAccepted || draft.claimIds.length === 0 || invalidClaimIds.length > 0 || invalidAnalysisRunIds.length > 0}>{t("research.saveReportVersion")}</button>
        {draft.baseId && <button type="button" className="research-workspace__text-button" onClick={() => setDraft(blankDraft())}>{t("research.startNewReport")}</button>}</div>
    </form>
  </section>;
}
