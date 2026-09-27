import { useEffect, useRef, useState, type FormEvent } from "react";
import { staleEvidenceIds, type ResearchExecutionLinkStatus, type ResearchExecutionTarget, type ResearchProject, type ResearchStudy, type ResearchTextSegment, type ResearchTextView } from "@brainpilot/protocol";
import { useSessions } from "../../contexts/SessionContext";
import { draftStore } from "../../contexts/draftStore";
import { useT } from "../../i18n/useT";
import { analysisRunStatus, ResearchDataAnalysis } from "./ResearchDataAnalysis";
import { executionLinkStatus, ExecutionLinkSummary, ResearchExecutionLinks } from "./ResearchExecutionLinks";
import { ResearchReports } from "./ResearchReports";
import { researchApi, type ResearchAnalysisRunStatus } from "./researchApi";
import { researchHandoffReview } from "./researchHandoffReview";
import "./research.css";

const approaches = ["undecided", "literature", "quantitative", "qualitative", "mixed", "theoretical", "education_ai"] as const;
const sourceKinds = ["publication", "dataset", "interview", "observation", "survey", "document", "other"] as const;
const claimKinds = ["description", "association", "causal", "interpretation", "theoretical"] as const;

function value(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "").trim();
}

function contextFrom(form: HTMLFormElement) {
  return {
    educationLevel: value(form, "educationLevel"), institution: value(form, "institution"),
    courseOrTask: value(form, "courseOrTask"), culturalSetting: value(form, "culturalSetting"),
    timeFrame: value(form, "timeFrame"),
  };
}

function uncertaintiesFrom(form: HTMLFormElement) {
  return value(form, "uncertainties").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function locatorLabel(locator: string, t: ReturnType<typeof useT>): string {
  const range = /:u16(\d+)-(\d+)$/.exec(locator);
  const base = range ? locator.slice(0, range.index) : locator;
  const manual = /^pdf:p(\d+):manual$/.exec(base);
  if (manual) return t("research.manualPageLocator", { page: manual[1] });
  const pdf = /^pdf:p(\d+):l(\d+)(?::part(\d+))?$/.exec(base);
  const docx = /^docx:p(\d+)(?::part(\d+))?$/.exec(base);
  const plain = /^text:l(\d+)(?::part(\d+))?$/.exec(base);
  const label = pdf ? t(pdf[3] ? "research.pdfLocatorPart" : "research.pdfLocator", { page: pdf[1], line: pdf[2], part: pdf[3] ?? "1" })
    : docx ? t(docx[2] ? "research.docxLocatorPart" : "research.docxLocator", { paragraph: docx[1], part: docx[2] ?? "1" })
      : plain ? t(plain[2] ? "research.textLocatorPart" : "research.textLocator", { line: plain[1], part: plain[2] ?? "1" })
        : base;
  return range ? `${label} · ${t("research.quoteRange", { start: Number(range[1]) + 1, end: range[2] })}` : label;
}

function ExtractedPassage({ segment, busy, onRecord }: {
  segment: ResearchTextSegment;
  busy: boolean;
  onRecord: (index: number, range?: { start: number; end: number }) => void;
}) {
  const t = useT();
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  return <li>
    <div className="research-workspace__section-head"><strong>{locatorLabel(segment.locator, t)}</strong>
      <button type="button" disabled={busy} onClick={() => onRecord(segment.index, selection ?? undefined)}>{t(selection ? "research.recordSelection" : "research.recordExcerpt")}</button>
    </div>
    <textarea className="research-workspace__quote-text" readOnly value={segment.text} rows={Math.min(8, Math.max(2, Math.ceil(segment.text.length / 90)))}
      aria-label={t("research.selectQuote", { locator: locatorLabel(segment.locator, t) })}
      onSelect={(event) => {
        const { selectionStart: start, selectionEnd: end } = event.currentTarget;
        setSelection(end > start ? { start, end } : null);
      }} />
    <p className="research-workspace__muted">{selection ? t("research.selectedChars", { count: selection.end - selection.start }) : t("research.selectHelp")}</p>
  </li>;
}

export function ResearchWorkspace({ beforeOpenSession, onOpenSession }: { beforeOpenSession: () => boolean; onOpenSession: () => void }) {
  const t = useT();
  const { createSession, selectSession } = useSessions();
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<{ project: ResearchProject; studies: ResearchStudy[] } | null>(null);
  const [studyId, setStudyId] = useState<string | null>(null);
  const [study, setStudy] = useState<ResearchStudy | null>(null);
  const selectedStudyIdRef = useRef<string | null>(null);
  selectedStudyIdRef.current = studyId;
  const [executionStatuses, setExecutionStatuses] = useState<ResearchExecutionLinkStatus[]>([]);
  const [executionStatusError, setExecutionStatusError] = useState("");
  const executionStatusRequests = useRef(new Map<string, Promise<{ statuses: ResearchExecutionLinkStatus[] }>>());
  const refreshExecutionStatusRef = useRef<(() => Promise<void>) | null>(null);
  const [analysisStatuses, setAnalysisStatuses] = useState<ResearchAnalysisRunStatus[]>([]);
  const [analysisStatusError, setAnalysisStatusError] = useState("");
  const analysisStatusRequests = useRef(new Map<string, Promise<{ statuses: ResearchAnalysisRunStatus[] }>>());
  const refreshAnalysisStatusRef = useRef<(() => Promise<void>) | null>(null);
  const [textView, setTextView] = useState<ResearchTextView | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    researchApi.listProjects().then(({ projects: records }) => {
      if (!active) return;
      setProjects(records);
      setProjectId((current) => current ?? records[0]?.id ?? null);
    }).catch((cause: unknown) => {
      if (active) setError(String(cause instanceof Error ? cause.message : cause));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!projectId) { setProjectDetail(null); setStudyId(null); return; }
    setProjectDetail(null);
    let active = true;
    researchApi.getProject(projectId).then((detail) => {
      if (!active) return;
      setProjectDetail(detail);
      setStudyId((current) => detail.studies.some((record) => record.id === current) ? current : detail.studies[0]?.id ?? null);
    }).catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [projectId]);

  useEffect(() => {
    setTextView(null);
    setExecutionStatuses([]);
    setExecutionStatusError("");
    setAnalysisStatuses([]);
    setAnalysisStatusError("");
    if (!studyId) { setStudy(null); return; }
    let active = true;
    researchApi.getStudy(studyId).then((record) => { if (active) setStudy(record); })
      .catch((cause: unknown) => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [studyId]);

  useEffect(() => {
    if (!study?.executionLinks.length) {
      refreshExecutionStatusRef.current = null;
      setExecutionStatuses([]);
      setExecutionStatusError("");
      return;
    }
    let active = true;
    const id = study.id;
    executionStatusRequests.current.delete(id);
    setExecutionStatuses([]);
    setExecutionStatusError("");
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      let pending = executionStatusRequests.current.get(id);
      if (!pending) {
        pending = researchApi.getExecutionLinkStatuses(id);
        executionStatusRequests.current.set(id, pending);
        void pending.then(() => { if (executionStatusRequests.current.get(id) === pending) executionStatusRequests.current.delete(id); },
          () => { if (executionStatusRequests.current.get(id) === pending) executionStatusRequests.current.delete(id); });
      }
      try {
        const { statuses } = await pending;
        if (active) { setExecutionStatuses(statuses); setExecutionStatusError(""); }
      } catch (cause) {
        if (active) { setExecutionStatuses([]); setExecutionStatusError(cause instanceof Error ? cause.message : String(cause)); }
      }
    };
    refreshExecutionStatusRef.current = refresh;
    void refresh();
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      if (refreshExecutionStatusRef.current === refresh) refreshExecutionStatusRef.current = null;
    };
  }, [study?.id, study?.updatedAt, study?.executionLinks.length]);

  useEffect(() => {
    if (!study?.analysisRuns.length) {
      refreshAnalysisStatusRef.current = null;
      setAnalysisStatuses([]);
      setAnalysisStatusError("");
      return;
    }
    setAnalysisStatuses([]);
    setAnalysisStatusError("");
    let active = true;
    const id = study.id;
    analysisStatusRequests.current.delete(id);
    const refresh = async () => {
      if (document.visibilityState === "hidden") return;
      let pending = analysisStatusRequests.current.get(id);
      if (!pending) {
        pending = researchApi.getAnalysisRunStatuses(id);
        analysisStatusRequests.current.set(id, pending);
        void pending.then(() => { if (analysisStatusRequests.current.get(id) === pending) analysisStatusRequests.current.delete(id); },
          () => { if (analysisStatusRequests.current.get(id) === pending) analysisStatusRequests.current.delete(id); });
      }
      try {
        const { statuses } = await pending;
        if (active) { setAnalysisStatuses(statuses); setAnalysisStatusError(""); }
      } catch (cause) {
        if (active) { setAnalysisStatuses([]); setAnalysisStatusError(cause instanceof Error ? cause.message : String(cause)); }
      }
    };
    refreshAnalysisStatusRef.current = refresh;
    void refresh();
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (refreshAnalysisStatusRef.current === refresh) refreshAnalysisStatusRef.current = null;
    };
  }, [study?.id, study?.updatedAt, study?.analysisRuns.length]);

  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError("");
    try { await action(); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };

  const applyStudy = (updated: ResearchStudy) => {
    setStudy((current) => selectedStudyIdRef.current === updated.id && current?.id === updated.id ? updated : current);
  };

  const onCreateProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    void run(async () => {
      const project = await researchApi.createProject({ title: value(form, "title"), description: value(form, "description") });
      setProjects((current) => [...current, project]);
      setProjectId(project.id);
      form.reset();
    });
  };

  const onCreateStudy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId) return;
    const form = event.currentTarget;
    void run(async () => {
      const record = await researchApi.createStudy(projectId, {
        title: value(form, "title"), question: value(form, "question"),
        entry: value(form, "entry"), approach: value(form, "approach"),
        purpose: value(form, "purpose"), context: contextFrom(form), uncertainties: uncertaintiesFrom(form),
      });
      const detail = await researchApi.getProject(projectId);
      setProjectDetail(detail);
      setStudyId(record.id);
      setStudy(record);
      form.reset();
    });
  };

  const submitStudy = (event: FormEvent<HTMLFormElement>, operation: "spec" | "source" | "evidence" | "plan" | "claim") => {
    event.preventDefault();
    if (!study) return;
    const form = event.currentTarget;
    const id = study.id;
    void run(async () => {
      let updated: ResearchStudy;
      if (operation === "spec") {
        updated = await researchApi.reviseStudy(id, {
          spec: { ...study.specs.at(-1)!.spec, title: value(form, "title"), question: value(form, "question"), approach: value(form, "approach"), purpose: value(form, "purpose"), context: contextFrom(form), uncertainties: uncertaintiesFrom(form) },
          reason: value(form, "reason"),
        });
      } else if (operation === "source") {
        updated = await researchApi.addSource(id, {
          title: value(form, "title"), kind: value(form, "kind"), origin: value(form, "origin"),
          citation: value(form, "citation"), locator: value(form, "locator"), accessNote: value(form, "accessNote"),
        });
      } else if (operation === "evidence") {
        const assetId = value(form, "assetId");
        updated = await researchApi.addEvidence(id, {
          sourceId: value(form, "sourceId"), kind: value(form, "kind"), locator: value(form, "locator"),
          content: value(form, "content"), note: value(form, "note"), ...(assetId ? { assetId } : {}),
        });
      } else if (operation === "plan") {
        updated = await researchApi.addPlan(id, {
          content: value(form, "content"), reason: value(form, "reason"),
          evidenceIds: new FormData(form).getAll("evidenceIds").map(String),
        });
      } else {
        const evidenceId = value(form, "evidenceId");
        updated = await researchApi.addClaim(id, {
          text: value(form, "text"), kind: value(form, "kind"), scope: value(form, "scope"),
          evidence: evidenceId ? [{ evidenceId, relation: value(form, "relation"), reason: value(form, "linkReason") }] : [],
          executionLinkIds: new FormData(form).getAll("executionLinkIds").map(String),
          analysisRunIds: new FormData(form).getAll("analysisRunIds").map(String),
        });
      }
      applyStudy(updated);
      form.reset();
    });
  };

  const uploadAsset = (event: FormEvent<HTMLFormElement>, sourceId: string) => {
    event.preventDefault();
    if (!study) return;
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
    if (!file) return;
    void run(async () => {
      applyStudy(await researchApi.uploadAsset(study.id, sourceId, file, value(form, "accessNote")));
      form.reset();
    });
  };

  const previewText = (assetId: string, section: number) => {
    if (!study) return;
    const studyId = study.id;
    void run(async () => {
      const view = await researchApi.getAssetText(studyId, assetId, section);
      if (selectedStudyIdRef.current === studyId) setTextView(view);
    });
  };

  const recordExtractedEvidence = (segmentIndex: number, selection?: { start: number; end: number }) => {
    if (!study || !textView) return;
    const view = textView;
    void run(async () => applyStudy(await researchApi.addEvidenceFromAsset(study.id, {
      assetId: view.assetId, section: view.section, segmentIndex, ...selection,
    })));
  };

  const recordManualPage = (event: FormEvent<HTMLFormElement>, assetId: string) => {
    event.preventDefault();
    if (!study) return;
    const form = event.currentTarget;
    void run(async () => {
      applyStudy(await researchApi.addManualPageEvidence(study.id, {
        assetId, page: Number(value(form, "page")), content: value(form, "content"), note: value(form, "note"),
      }));
      form.reset();
    });
  };

  const decidePlan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!study?.plans.length) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value === "return" ? "return" : "accept";
    void run(async () => {
      const updated = await researchApi.decide(study.id, {
        target: "plan", targetId: study.plans.at(-1)!.id, decision, reason: value(form, "reason"),
      });
      applyStudy(updated);
      form.reset();
    });
  };

  const verifyEvidence = (event: FormEvent<HTMLFormElement>, evidenceId: string) => {
    event.preventDefault();
    if (!study) return;
    const form = event.currentTarget;
    void run(async () => {
      applyStudy(await researchApi.verifyEvidence(study.id, {
        evidenceId, level: value(form, "level"), reason: value(form, "reason"),
      }));
      form.reset();
    });
  };

  const decideClaim = (event: FormEvent<HTMLFormElement>, claimId: string) => {
    event.preventDefault();
    if (!study) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value === "return" ? "return" : "accept";
    void run(async () => {
      applyStudy(await researchApi.decide(study.id, {
        target: "claim", targetId: claimId, decision, reason: value(form, "reason"),
      }));
      form.reset();
    });
  };

  const currentSpec = study?.specs.at(-1);
  const latestPlan = study?.plans.at(-1);
  const planDecision = latestPlan && study?.decisions.slice().reverse().find((decision) => decision.target === "plan" && decision.targetId === latestPlan.id);
  const planStale = Boolean(latestPlan && currentSpec && latestPlan.specVersionId !== currentSpec.id);
  const staleEvidence = study ? staleEvidenceIds(study) : new Set<string>();
  const planEvidenceStale = Boolean(latestPlan?.evidenceIds.some((id) => staleEvidence.has(id)));
  const canLinkExecution = Boolean(latestPlan && planDecision?.decision === "accept" && !planStale && !planEvidenceStale);
  const startAgentFromPlan = () => {
    if (!study || !canLinkExecution || !beforeOpenSession()) return;
    const id = study.id;
    void run(async () => {
      // Re-read and validate on the server. The visible study may have changed
      // since it was fetched, and the draft must never include raw assets.
      const context = await researchApi.getAgentContext(id);
      const session = await createSession(context.title, { researchDomain: "education" });
      if (!session) throw new Error(t("research.agentSessionUnavailable"));
      draftStore.set(session.id, context.prompt);
      researchHandoffReview.mark(session.id);
      selectSession(session.id);
      try {
        applyStudy(await researchApi.addExecutionLink(id, {
          planVersionId: context.planVersionId, sessionId: session.id,
          target: { kind: "session" }, note: t("research.agentExecutionNote"),
        }));
      } catch (cause) {
        // Keep the unsent draft in its new session so the researcher can review
        // it and attach the execution link manually if this second write fails.
        throw new Error(t("research.agentLinkFailed", { message: cause instanceof Error ? cause.message : String(cause) }));
      }
      onOpenSession();
    });
  };
  const addExecutionLink = (input: { planVersionId: string; sessionId: string; target: ResearchExecutionTarget; note: string }): Promise<boolean> => {
    if (!study) return Promise.resolve(false);
    return run(async () => applyStudy(await researchApi.addExecutionLink(study.id, input)));
  };
  const refreshExecutionStatuses = () => {
    void refreshExecutionStatusRef.current?.();
  };
  const refreshAnalysisStatuses = () => {
    void refreshAnalysisStatusRef.current?.();
  };
  const mutateStudy = (action: () => Promise<ResearchStudy>): Promise<boolean> =>
    run(async () => {
      const updated = await action();
      applyStudy(updated);
    });
  const activeSourceId = study?.sources.some((source) => source.id === selectedSourceId) ? selectedSourceId : study?.sources[0]?.id ?? "";
  const previewAsset = study?.assets.find((asset) => asset.id === textView?.assetId);

  return <main className="research-workspace" aria-labelledby="research-title">
    <header className="research-workspace__header">
      <h1 id="research-title">{t("research.title")}</h1>
      <p>{t("research.subtitle")}</p>
    </header>
    {error && <div className="research-workspace__error" role="alert">{t("research.error", { message: error })}</div>}
    {loading ? <p role="status">{t("research.loading")}</p> : null}
    <div className="research-workspace__layout">
      <aside className="research-workspace__nav" aria-label={t("research.projects")}>
        <h2>{t("research.projects")}</h2>
        {projects.length === 0 && !loading ? <p>{t("research.noProjects")}</p> : null}
        {projects.map((project) => <button type="button" key={project.id} disabled={busy} className={project.id === projectId ? "is-active" : ""} onClick={() => { selectedStudyIdRef.current = null; setProjectDetail(null); setProjectId(project.id); setStudyId(null); setStudy(null); }}>{project.title}</button>)}
        <details>
          <summary>{t("research.newProject")}</summary>
          <form onSubmit={onCreateProject}>
            <label>{t("research.projectTitle")}<input name="title" required maxLength={240} /></label>
            <label>{t("research.description")}<textarea name="description" rows={2} /></label>
            <button disabled={busy} type="submit">{t("research.create")}</button>
          </form>
        </details>
        {projectDetail && <section>
          <h2>{t("research.studies")}</h2>
          {projectDetail.studies.length === 0 && <p>{t("research.noStudies")}</p>}
          {projectDetail.studies.map((record) => <button type="button" key={record.id} disabled={busy} className={record.id === studyId ? "is-active" : ""} onClick={() => { selectedStudyIdRef.current = record.id; setStudyId(record.id); setStudy(null); }}>{record.specs.at(-1)?.spec.title}</button>)}
          <details>
            <summary>{t("research.newStudy")}</summary>
            <form onSubmit={onCreateStudy}>
              <label>{t("research.studyTitle")}<input name="title" required maxLength={240} /></label>
              <label>{t("research.question")}<textarea name="question" required rows={3} /></label>
              <label>{t("research.purpose")}<textarea name="purpose" rows={2} /></label>
              <label>{t("research.entry")}<select name="entry"><option value="idea">{t("research.idea")}</option><option value="materials">{t("research.materials")}</option><option value="manuscript">{t("research.manuscript")}</option></select></label>
              <label>{t("research.approach")}<select name="approach">{approaches.map((item) => <option value={item} key={item}>{t(`research.${item}`)}</option>)}</select></label>
              <label>{t("research.educationLevel")}<input name="educationLevel" /></label>
              <label>{t("research.institution")}<input name="institution" /></label>
              <label>{t("research.courseOrTask")}<input name="courseOrTask" /></label>
              <label>{t("research.culturalSetting")}<input name="culturalSetting" /></label>
              <label>{t("research.timeFrame")}<input name="timeFrame" /></label>
              <label>{t("research.uncertainties")}<textarea name="uncertainties" rows={2} /></label>
              <button disabled={busy} type="submit">{t("research.create")}</button>
            </form>
          </details>
        </section>}
      </aside>
      <div className="research-workspace__content">
        {study && study.id === studyId && currentSpec ? <>
          <section className="research-workspace__card">
            <div className="research-workspace__section-head"><h2>{t("research.definition")}</h2><span>{t("research.currentVersion", { version: currentSpec.version })}</span></div>
            <h3>{currentSpec.spec.title}</h3><p>{currentSpec.spec.question}</p>
            {currentSpec.spec.purpose && <p>{currentSpec.spec.purpose}</p>}
            <p className="research-workspace__muted">{t(`research.${currentSpec.spec.entry}`)} · {t(`research.${currentSpec.spec.approach}`)}</p>
            <p className="research-workspace__muted">{Object.entries(currentSpec.spec.context).filter(([, field]) => field).map(([key, field]) => `${t(`research.${key}`)}: ${field}`).join(" · ")}</p>
            {currentSpec.spec.uncertainties.length > 0 && <p className="research-workspace__muted">{t("research.uncertainties")}: {currentSpec.spec.uncertainties.join("; ")}</p>}
            {study.specs.length > 1 && <details><summary>{t("research.history")}</summary><ol>{study.specs.map((version) => <li key={version.id}><strong>v{version.version}</strong> · {version.spec.question}<br /><span className="research-workspace__muted">{version.reason} · {version.createdAt}</span></li>)}</ol></details>}
            <details><summary>{t("research.revise")}</summary><form key={currentSpec.id} onSubmit={(event) => submitStudy(event, "spec")}>
              <label>{t("research.studyTitle")}<input name="title" defaultValue={currentSpec.spec.title} required /></label>
              <label>{t("research.question")}<textarea name="question" defaultValue={currentSpec.spec.question} required rows={3} /></label>
              <label>{t("research.purpose")}<textarea name="purpose" defaultValue={currentSpec.spec.purpose} rows={2} /></label>
              <label>{t("research.approach")}<select name="approach" defaultValue={currentSpec.spec.approach}>{approaches.map((item) => <option value={item} key={item}>{t(`research.${item}`)}</option>)}</select></label>
              <label>{t("research.educationLevel")}<input name="educationLevel" defaultValue={currentSpec.spec.context.educationLevel} /></label>
              <label>{t("research.institution")}<input name="institution" defaultValue={currentSpec.spec.context.institution} /></label>
              <label>{t("research.courseOrTask")}<input name="courseOrTask" defaultValue={currentSpec.spec.context.courseOrTask} /></label>
              <label>{t("research.culturalSetting")}<input name="culturalSetting" defaultValue={currentSpec.spec.context.culturalSetting} /></label>
              <label>{t("research.timeFrame")}<input name="timeFrame" defaultValue={currentSpec.spec.context.timeFrame} /></label>
              <label>{t("research.uncertainties")}<textarea name="uncertainties" defaultValue={currentSpec.spec.uncertainties.join("\n")} rows={2} /></label>
              <label>{t("research.revisionReason")}<input name="reason" required /></label>
              <button disabled={busy} type="submit">{t("research.revise")}</button>
            </form></details>
          </section>
          <section className="research-workspace__card">
            <h2>{t("research.sources")}</h2>
            <ul>{study.sources.map((source) => {
              const assets = study.assets.filter((asset) => asset.sourceId === source.id && asset.mediaType !== "text/csv");
              return <li key={source.id}><strong>{source.title}</strong> <span className="research-workspace__muted">{t(`research.${source.origin}`)} · {source.locator || source.citation}</span>
                {source.accessNote && <p className="research-workspace__muted">{t("research.accessNote")}: {source.accessNote}</p>}
                {assets.length > 0 && <ol className="research-workspace__asset-list">{assets.map((asset) => <li key={asset.id}>
                  <a href={researchApi.assetDownloadUrl(study.id, asset.id)}>{asset.filename}</a> · v{asset.version} · {Math.ceil(asset.sizeBytes / 1024)} KB
                  <span className="research-workspace__muted"> · SHA-256 {asset.sha256.slice(0, 12)}… · {asset.accessNote}</span>
                  <button className="research-workspace__text-button" type="button" disabled={busy} onClick={() => previewText(asset.id, 1)}>{t("research.previewText")}</button>
                  {asset.mediaType === "application/pdf" && <>
                    <a href={researchApi.assetViewUrl(study.id, asset.id)} target="_blank" rel="noopener noreferrer">{t("research.openOriginalPdf")}</a>
                    <details><summary>{t("research.manualPageEvidence")}</summary><form onSubmit={(event) => recordManualPage(event, asset.id)}>
                      <p className="research-workspace__muted">{t("research.manualPageHelp")}</p>
                      <label>{t("research.pdfPageNumber")}<input name="page" type="number" min={1} step={1} required /></label>
                      <label>{t("research.transcribedContent")}<textarea name="content" rows={4} required maxLength={20000} /></label>
                      <label>{t("research.transcriptionNote")}<input name="note" required maxLength={240} /></label>
                      <button disabled={busy} type="submit">{t("research.recordManualPage")}</button>
                    </form></details>
                  </>}
                </li>)}</ol>}
                {source.kind !== "dataset" && <details><summary>{t("research.uploadFile")}</summary><form onSubmit={(event) => uploadAsset(event, source.id)}>
                  <label>{t("research.file")}<input name="file" type="file" accept=".pdf,.docx,.txt,.md" required /></label>
                  <label>{t("research.accessNote")}<input name="accessNote" required maxLength={2000} /></label>
                  <p className="research-workspace__muted">{t("research.uploadHelp")}</p>
                  <button disabled={busy} type="submit">{t("research.uploadFile")}</button>
                </form></details>}
              </li>;
            })}</ul>
            <details><summary>{t("research.addSource")}</summary><form onSubmit={(event) => submitStudy(event, "source")}>
              <label>{t("research.sourceTitle")}<input name="title" required /></label>
              <label>{t("research.sourceKind")}<select name="kind">{sourceKinds.map((item) => <option value={item} key={item}>{t(`research.${item}`)}</option>)}</select></label>
              <label>{t("research.origin")}<select name="origin">{(["observed", "curated", "simulated", "generated"] as const).map((item) => <option value={item} key={item}>{t(`research.${item}`)}</option>)}</select></label>
              <label>{t("research.citation")}<input name="citation" /></label>
              <label>{t("research.locator")}<input name="locator" /></label>
              <label>{t("research.accessNote")}<input name="accessNote" /></label>
              <button disabled={busy} type="submit">{t("research.addSource")}</button>
            </form></details>
          </section>
          {textView && previewAsset && <section className="research-workspace__card" aria-label={t("research.textPreview")}>
            <div className="research-workspace__section-head"><h2>{t("research.textPreview")}</h2><span>{previewAsset.filename} · v{previewAsset.version}</span></div>
            <p className="research-workspace__muted">{t("research.previewScope")}</p>
            <div className="research-workspace__pager">
              <button type="button" disabled={busy || textView.section === 1} onClick={() => previewText(textView.assetId, textView.section - 1)}>{t("research.previousSection")}</button>
              <span>{t(textView.sectionKind === "page" ? "research.pageSection" : textView.sectionKind === "paragraphs" ? "research.paragraphSection" : "research.lineSection", { current: textView.section, total: textView.sectionCount })}</span>
              <button type="button" disabled={busy || textView.section === textView.sectionCount} onClick={() => previewText(textView.assetId, textView.section + 1)}>{t("research.nextSection")}</button>
            </div>
            {textView.warnings.map((warning, index) => <p className="research-workspace__warning" key={`${index}-${warning}`}>{warning === "NO_SELECTABLE_TEXT" ? t("research.noSelectableText") : warning}</p>)}
            {textView.segments.length === 0 && <p className="research-workspace__muted">{t("research.noExtractedText")}</p>}
            <ol className="research-workspace__passages">{textView.segments.map((segment) => <ExtractedPassage
              key={`${textView.assetId}:${textView.section}:${segment.index}`} segment={segment} busy={busy} onRecord={recordExtractedEvidence} />)}</ol>
          </section>}
          <section className="research-workspace__card">
            <h2>{t("research.evidence")}</h2>
            <ul>{study.evidence.map((item) => {
              const asset = study.assets.find((record) => record.id === item.assetId);
              return <li key={item.id}><strong>{item.content}</strong><br /><span className="research-workspace__muted">{t(item.kind === "source_excerpt" ? "research.excerpt" : item.kind === "manual_transcription" ? "research.manualTranscription" : item.kind === "researcher_note" ? "research.note" : "research.modelSummary")} · {t(item.captureMethod === "extracted" ? "research.extractedCapture" : item.captureMethod === "transcribed" ? "research.transcribedCapture" : "research.manualCapture")} · {study.sources.find((source) => source.id === item.sourceId)?.title} · {locatorLabel(item.locator, t)} · {t(item.verification === "content_checked" ? "research.contentChecked" : item.verification === "source_checked" ? "research.sourceChecked" : "research.unverified")}</span>
              {asset && <p className="research-workspace__muted">{t("research.fileVersion")}: <a href={researchApi.assetDownloadUrl(study.id, asset.id)}>{asset.filename} v{asset.version}</a></p>}
              {item.note && <p className="research-workspace__muted">{t("research.note")}: {item.note}</p>}
              {staleEvidence.has(item.id) && <p className="research-workspace__warning">{t("research.evidenceStale")}</p>}
              {study.verifications.filter((record) => record.evidenceId === item.id).map((record) => <p className="research-workspace__muted" key={record.id}>{record.reason} · {record.actorId} · {record.createdAt}</p>)}
              {item.verification !== "content_checked" && <details><summary>{t("research.verify")}</summary><form onSubmit={(event) => verifyEvidence(event, item.id)}>
                <label>{t("research.verify")}<select name="level">{item.verification === "unverified" && <option value="source_checked">{t("research.sourceChecked")}</option>}<option value="content_checked">{t("research.contentChecked")}</option></select></label>
                <label>{t("research.verificationReason")}<input name="reason" required /></label>
                <button disabled={busy} type="submit">{t("research.verify")}</button>
              </form></details>}
            </li>;
            })}</ul>
            {study.sources.length > 0 && <details><summary>{t("research.addEvidence")}</summary><form onSubmit={(event) => submitStudy(event, "evidence")}>
              <label>{t("research.source")}<select name="sourceId" value={activeSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}>{study.sources.map((source) => <option value={source.id} key={source.id}>{source.title}</option>)}</select></label>
              <label>{t("research.fileVersion")}<select name="assetId"><option value="">{t("research.noFile")}</option>{study.assets.filter((asset) => asset.sourceId === activeSourceId).map((asset) => <option value={asset.id} key={asset.id}>{asset.filename} v{asset.version}</option>)}</select></label>
              <label>{t("research.content")}<select name="kind"><option value="source_excerpt">{t("research.excerpt")}</option><option value="researcher_note">{t("research.note")}</option><option value="model_summary">{t("research.modelSummary")}</option></select></label>
              <label>{t("research.locator")}<input name="locator" required /></label>
              <label>{t("research.content")}<textarea name="content" required rows={4} /></label>
              <label>{t("research.note")}<textarea name="note" rows={2} /></label>
              <button disabled={busy} type="submit">{t("research.addEvidence")}</button>
            </form></details>}
          </section>
          <section className="research-workspace__card">
            <h2>{t("research.plans")}</h2>
            {latestPlan && <article><div className="research-workspace__section-head"><strong>{t("research.currentVersion", { version: latestPlan.version })}</strong><span>{planStale ? t("research.planStale") : planDecision ? t(planDecision.decision === "accept" ? "research.statusAccepted" : "research.statusReturned") : t("research.planPending")}</span></div><p className="research-workspace__preserve">{latestPlan.content}</p>{planEvidenceStale && <p className="research-workspace__warning">{t("research.planEvidenceStale")}</p>}</article>}
            {study.plans.length > 1 && <details><summary>{t("research.history")}</summary><ol>{study.plans.map((version) => {
              const decision = study.decisions.find((record) => record.target === "plan" && record.targetId === version.id);
              return <li key={version.id}><strong>v{version.version}</strong> · {decision ? t(decision.decision === "accept" ? "research.statusAccepted" : "research.statusReturned") : t("research.planPending")}<p className="research-workspace__preserve">{version.content}</p><span className="research-workspace__muted">{version.reason} · {decision?.reason}</span></li>;
            })}</ol></details>}
            {latestPlan && !planDecision && !planStale && <form className="research-workspace__decision" onSubmit={decidePlan}>
              <label>{t("research.decisionReason")}<input name="reason" required /></label>
              <div><button disabled={busy || planEvidenceStale} type="submit" value="accept">{t("research.accept")}</button><button disabled={busy} type="submit" value="return">{t("research.return")}</button></div>
            </form>}
            <details><summary>{t("research.addPlan")}</summary><form onSubmit={(event) => submitStudy(event, "plan")}>
              <label>{t("research.planContent")}<textarea name="content" required rows={7} /></label>
              <label>{t("research.planReason")}<input name="reason" /></label>
              {study.evidence.length > 0 && <fieldset><legend>{t("research.supportingEvidence")}</legend>{study.evidence.map((item) => <label key={item.id}><input type="checkbox" name="evidenceIds" value={item.id} />{item.content.slice(0, 120)}</label>)}</fieldset>}
              <button disabled={busy} type="submit">{t("research.addPlan")}</button>
            </form></details>
          </section>
          <section className="research-workspace__card">
            <h2>{t("research.agentHandoff")}</h2>
            <p className="research-workspace__muted">{t("research.agentHandoffHelp")}</p>
            <button className="research-workspace__primary-button" type="button" disabled={busy || !canLinkExecution} onClick={startAgentFromPlan}>{t("research.startEducationSession")}</button>
            {!canLinkExecution && <p className="research-workspace__muted">{t("research.executionRequiresPlan")}</p>}
          </section>
          <ResearchExecutionLinks study={study} planVersionId={latestPlan?.id} canLink={canLinkExecution} statuses={executionStatuses} statusError={executionStatusError} busy={busy} onAdd={addExecutionLink} onRefresh={refreshExecutionStatuses} />
          <ResearchDataAnalysis key={study.id} study={study} planVersionId={latestPlan?.id} canRun={canLinkExecution} busy={busy} statuses={analysisStatuses} statusError={analysisStatusError} onMutate={mutateStudy} onRefresh={refreshAnalysisStatuses} />
          <section className="research-workspace__card">
            <h2>{t("research.claims")}</h2>
            <ul>{study.claims.map((claim) => {
              const decision = study.decisions.find((record) => record.target === "claim" && record.targetId === claim.id);
              const claimEvidenceStale = claim.evidence.some((link) => staleEvidence.has(link.evidenceId));
              const claimExecutionLinks = claim.executionLinkIds.map((id) => study.executionLinks.find((link) => link.id === id)).filter((link): link is NonNullable<typeof link> => Boolean(link));
              const claimExecutionStale = claim.executionLinkIds.length !== claimExecutionLinks.length || claimExecutionLinks.some((link) => executionLinkStatus(study, link, executionStatuses, executionStatusError)?.status !== "current");
              const claimAnalysisRuns = claim.analysisRunIds.map((id) => study.analysisRuns.find((run) => run.id === id)).filter((run): run is NonNullable<typeof run> => Boolean(run));
              const claimAnalysisStale = claim.analysisRunIds.length !== claimAnalysisRuns.length || claimAnalysisRuns.some((run) => analysisRunStatus(run.id, analysisStatuses, analysisStatusError)?.status !== "current");
              return <li key={claim.id}><strong>{claim.text}</strong><br /><span className="research-workspace__muted">{claim.kind} · {claim.scope || t("research.none")} · {claim.evidence.length} {t("research.evidence")} · {decision ? t(decision.decision === "accept" ? "research.statusAccepted" : "research.statusReturned") : t("research.claimPending")}</span>
                {claimEvidenceStale && <p className="research-workspace__warning">{t("research.claimEvidenceStale")}</p>}
                {claimExecutionStale && <p className="research-workspace__warning">{t("research.claimExecutionStale")}</p>}
                {claimAnalysisStale && <p className="research-workspace__warning">{t("research.claimAnalysisStale")}</p>}
                {claim.evidence.map((link) => <p className="research-workspace__muted" key={link.evidenceId}>{t(`research.${link.relation}`)}: {study.evidence.find((record) => record.id === link.evidenceId)?.content}</p>)}
                {claimExecutionLinks.map((link) => <ExecutionLinkSummary key={link.id} study={study} link={link} statuses={executionStatuses} statusError={executionStatusError} />)}
                {claimAnalysisRuns.map((run) => <p className="research-workspace__muted" key={run.id}>{t("research.analysisResultVersion", { version: run.version })} · n={run.result.overall.n} · {t("research.mean")}: {run.result.overall.mean === null ? "—" : run.result.overall.mean.toLocaleString(undefined, { maximumFractionDigits: 4 })}</p>)}
                {!decision && <details><summary>{t("research.decisionReason")}</summary><form onSubmit={(event) => decideClaim(event, claim.id)}>
                  <label>{t("research.decisionReason")}<input name="reason" required /></label>
                  <div className="research-workspace__decision-actions"><button disabled={busy || claimEvidenceStale || claimExecutionStale || claimAnalysisStale} type="submit" value="accept">{t("research.accept")}</button><button disabled={busy} type="submit" value="return">{t("research.return")}</button></div>
                </form></details>}
              </li>;
            })}</ul>
            <details><summary>{t("research.addClaim")}</summary><form onSubmit={(event) => submitStudy(event, "claim")}>
              <label>{t("research.claimText")}<textarea name="text" required rows={3} /></label>
              <label>{t("research.claimKind")}<select name="kind">{claimKinds.map((item) => <option value={item} key={item}>{t(item === "description" ? "research.descriptionClaim" : `research.${item}`)}</option>)}</select></label>
              <label>{t("research.scope")}<input name="scope" /></label>
              {study.evidence.length > 0 && <><label>{t("research.supportingEvidence")}<select name="evidenceId"><option value="">{t("research.none")}</option>{study.evidence.map((item) => <option value={item.id} key={item.id}>{item.content.slice(0, 100)}</option>)}</select></label>
              <label>{t("research.supportingEvidence")}<select name="relation"><option value="supports">{t("research.supports")}</option><option value="challenges">{t("research.challenges")}</option><option value="limits">{t("research.limits")}</option></select></label>
              <label>{t("research.decisionReason")}<input name="linkReason" /></label></>}
              {study.executionLinks.length > 0 && <fieldset><legend>{t("research.claimExecutionLinks")}</legend>{study.executionLinks.map((link) => {
                const status = executionLinkStatus(study, link, executionStatuses, executionStatusError);
                return <label key={link.id}><input type="checkbox" name="executionLinkIds" value={link.id} />{link.snapshot.targetLabel} · {link.snapshot.sessionTitle} · {t(status ? `research.executionStatus_${status.status}` : "research.executionStatus_checking")}</label>;
              })}</fieldset>}
              {study.analysisRuns.length > 0 && <fieldset><legend>{t("research.claimAnalysisRuns")}</legend>{study.analysisRuns.map((run) => {
                const status = analysisRunStatus(run.id, analysisStatuses, analysisStatusError);
                return <label key={run.id}><input type="checkbox" name="analysisRunIds" value={run.id} />{t("research.analysisResultVersion", { version: run.version })} · {t(status ? `research.analysisStatus_${status.status}` : "research.analysisStatus_checking")}</label>;
              })}</fieldset>}
              <button disabled={busy} type="submit">{t("research.addClaim")}</button>
            </form></details>
          </section>
          <ResearchReports key={study.id} study={study} busy={busy} analysisStatuses={analysisStatuses} analysisStatusError={analysisStatusError} executionStatuses={executionStatuses} executionStatusError={executionStatusError} onMutate={mutateStudy} />
        </> : <div className="research-workspace__empty">{projectDetail ? t("research.noStudies") : t("research.noProjects")}</div>}
      </div>
    </div>
  </main>;
}
