import { useEffect, useState, type FormEvent } from "react";
import { latestCleaningRunForAsset, type ResearchStudy } from "@brainpilot/protocol";
import { useT } from "../../i18n/useT";
import { researchApi, type ResearchAnalysisRunStatus, type ResearchTableProfile } from "./researchApi";

type Recipe = {
  valueColumn: string;
  groupColumn?: string;
  missingTokens: string[];
  trimWhitespace: boolean;
  invalidNumeric: "error" | "exclude";
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function numberLabel(value: number | null): string {
  return value === null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function analysisRunStatus(runId: string, statuses: ResearchAnalysisRunStatus[], statusError = ""): ResearchAnalysisRunStatus | undefined {
  const status = statuses.find((item) => item.runId === runId);
  return status ?? (statusError ? { runId, status: "unavailable", reasons: [] } : undefined);
}

export function ResearchDataAnalysis({ study, planVersionId, canRun, busy, statuses, statusError, onMutate, onRefresh }: {
  study: ResearchStudy;
  planVersionId?: string;
  canRun: boolean;
  busy: boolean;
  statuses: ResearchAnalysisRunStatus[];
  statusError: string;
  onMutate: (action: () => Promise<ResearchStudy>) => Promise<boolean>;
  onRefresh: () => void;
}) {
  const t = useT();
  const datasetSources = study.sources.filter((source) => source.kind === "dataset");
  const csvAssets = study.assets.filter((asset) => asset.mediaType === "text/csv");
  const latestAssets = datasetSources.map((source) => csvAssets.filter((asset) => asset.sourceId === source.id).sort((a, b) => b.version - a.version)[0]).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
  const latestAssetIds = latestAssets.map((asset) => asset.id).join(",");
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [profile, setProfile] = useState<ResearchTableProfile | null>(null);
  const [profileError, setProfileError] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [selectedCleaningRunId, setSelectedCleaningRunId] = useState("");

  useEffect(() => {
    setSelectedAssetId((current) => latestAssets.some((asset) => asset.id === current) ? current : latestAssets.at(-1)?.id ?? "");
  }, [study.id, latestAssetIds]);

  useEffect(() => {
    setProfile(null);
    setProfileError("");
    if (!selectedAssetId) return;
    let active = true;
    setProfileLoading(true);
    researchApi.getTableProfile(study.id, selectedAssetId).then((record) => {
      if (active) setProfile(record);
    }).catch((cause: unknown) => {
      if (active) setProfileError(errorMessage(cause));
    }).finally(() => { if (active) setProfileLoading(false); });
    return () => { active = false; };
  }, [study.id, selectedAssetId]);

  const selectedAsset = latestAssets.find((asset) => asset.id === selectedAssetId);
  const currentCleaningRun = planVersionId && selectedAssetId
    ? latestCleaningRunForAsset(study, planVersionId, selectedAssetId)
    : undefined;
  const eligibleCleaningRuns = currentCleaningRun ? [currentCleaningRun] : [];
  const eligibleRunIds = eligibleCleaningRuns.map((run) => run.id).join(",");
  useEffect(() => {
    setSelectedCleaningRunId((current) => eligibleCleaningRuns.some((run) => run.id === current) ? current : eligibleCleaningRuns.at(-1)?.id ?? "");
  }, [study.id, eligibleRunIds]);

  const upload = (event: FormEvent<HTMLFormElement>, sourceId: string) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
    const accessNote = String(new FormData(form).get("accessNote") ?? "").trim();
    if (!file) return;
    void onMutate(() => researchApi.uploadTableAsset(study.id, sourceId, file, accessNote)).then((success) => { if (success) form.reset(); });
  };

  const clean = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun || !planVersionId || !selectedAsset || !profile) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const valueColumn = String(data.get("valueColumn") ?? "");
    const groupColumn = String(data.get("groupColumn") ?? "");
    const recipe: Recipe = {
      valueColumn,
      ...(groupColumn ? { groupColumn } : {}),
      missingTokens: [...new Set(["", ...String(data.get("missingTokens") ?? "").split(/[,\r\n]/).map((item) => item.trim()).filter(Boolean)])],
      trimWhitespace: data.has("trimWhitespace"),
      invalidNumeric: data.get("invalidNumeric") === "exclude" ? "exclude" : "error",
    };
    const reason = String(data.get("reason") ?? "").trim();
    void onMutate(() => researchApi.addCleaningRun(study.id, { planVersionId, assetId: selectedAsset.id, recipe, reason })).then((success) => { if (success) form.reset(); });
  };

  const analyze = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRun || !selectedCleaningRunId) return;
    void onMutate(() => researchApi.addAnalysisRun(study.id, { cleaningRunId: selectedCleaningRunId }));
  };

  return <section className="research-workspace__card">
    <div className="research-workspace__section-head"><h2>{t("research.dataAnalysis")}</h2><button className="research-workspace__text-button" type="button" disabled={busy} onClick={onRefresh}>{t("research.refreshAnalysisStatus")}</button></div>
    <p className="research-workspace__muted">{t("research.dataAnalysisHelp")}</p>
    <p className="research-workspace__muted">{t("research.descriptiveOnly")}</p>
    {datasetSources.length === 0 && <p className="research-workspace__muted">{t("research.noDatasetSources")}</p>}
    {datasetSources.map((source) => {
      const assets = csvAssets.filter((asset) => asset.sourceId === source.id);
      return <div className="research-workspace__dataset" key={source.id}>
        <h3>{source.title}</h3>
        {assets.length > 0 && <ul>{assets.map((asset) => <li key={asset.id}><a href={researchApi.assetDownloadUrl(study.id, asset.id)}>{asset.filename}</a> · v{asset.version} · SHA-256 {asset.sha256.slice(0, 12)}…</li>)}</ul>}
        <details><summary>{t("research.uploadCsv")}</summary><form onSubmit={(event) => upload(event, source.id)}>
          <label>{t("research.file")}<input name="file" type="file" accept=".csv,text/csv" required /></label>
          <label>{t("research.accessNote")}<input name="accessNote" required maxLength={2000} /></label>
          <p className="research-workspace__muted">{t("research.csvUploadHelp")}</p>
          <button type="submit" disabled={busy}>{t("research.uploadCsv")}</button>
        </form></details>
      </div>;
    })}
    {latestAssets.length > 0 && <>
      <h3>{t("research.tableProfile")}</h3>
      <label className="research-workspace__standalone-label">{t("research.datasetVersion")}
        <select value={selectedAssetId} onChange={(event) => setSelectedAssetId(event.target.value)}>{latestAssets.map((asset) => <option key={asset.id} value={asset.id}>{study.sources.find((source) => source.id === asset.sourceId)?.title} · {asset.filename} v{asset.version}</option>)}</select>
      </label>
      {profileLoading && <p className="research-workspace__muted">{t("research.loadingTableProfile")}</p>}
      {profileError && <p className="research-workspace__warning">{t("research.tableProfileUnavailable", { message: profileError })}</p>}
      {profile && profile.assetId === selectedAssetId && <>
        <p className="research-workspace__muted">{t("research.tableRows", { count: profile.rowCount })} · SHA-256 {profile.sha256.slice(0, 12)}…</p>
        <div className="research-workspace__table-scroll"><table><thead><tr><th>{t("research.columnName")}</th><th>{t("research.nonEmptyValues")}</th><th>{t("research.numericValues")}</th></tr></thead><tbody>{profile.columns.map((column) => <tr key={column.name}><td>{column.name}</td><td>{column.nonEmptyCount}</td><td>{column.numericCount}</td></tr>)}</tbody></table></div>
      </>}
    </>}
    {!canRun && <p className="research-workspace__muted">{t("research.analysisRequiresPlan")}</p>}
    {canRun && selectedAsset && profile && profile.assetId === selectedAsset.id && <details><summary>{t("research.cleanDataset")}</summary><form key={selectedAsset.id} onSubmit={clean}>
      <label>{t("research.valueColumn")}<select name="valueColumn" required>{profile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
      <label>{t("research.groupColumn")}<select name="groupColumn"><option value="">{t("research.noGrouping")}</option>{profile.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}</select></label>
      <label>{t("research.missingTokens")}<textarea name="missingTokens" rows={2} defaultValue={"NA\nN/A"} /></label>
      <label className="research-workspace__checkbox-label"><input name="trimWhitespace" type="checkbox" defaultChecked />{t("research.trimWhitespace")}</label>
      <label>{t("research.invalidNumeric")}<select name="invalidNumeric"><option value="error">{t("research.invalidNumericError")}</option><option value="exclude">{t("research.invalidNumericExclude")}</option></select></label>
      <label>{t("research.cleaningReason")}<input name="reason" maxLength={2000} /></label>
      <button type="submit" disabled={busy}>{t("research.cleanDataset")}</button>
    </form></details>}
    {study.cleaningRuns.length > 0 && <>
      <h3>{t("research.cleaningHistory")}</h3>
      <ol>{study.cleaningRuns.map((run) => <li key={run.id}><strong>v{run.version}</strong> · {study.assets.find((asset) => asset.id === run.assetId)?.filename ?? run.assetId} · {run.createdAt}
        <p className="research-workspace__muted">{t("research.valueColumn")}: {run.recipe.valueColumn}{run.recipe.groupColumn ? ` · ${t("research.groupColumn")}: ${run.recipe.groupColumn}` : ""} · SHA-256 {run.cleanedSha256.slice(0, 12)}…</p>
        <p className="research-workspace__muted">{Object.entries(run.counts).map(([name, count]) => `${t(`research.count_${name}`)}: ${count}`).join(" · ")}</p>
      </li>)}</ol>
    </>}
    {canRun && eligibleCleaningRuns.length > 0 && <form onSubmit={analyze}>
      <label>{t("research.cleanedVersion")}<select value={selectedCleaningRunId} onChange={(event) => setSelectedCleaningRunId(event.target.value)}>{eligibleCleaningRuns.map((run) => <option key={run.id} value={run.id}>v{run.version} · {study.assets.find((asset) => asset.id === run.assetId)?.filename ?? run.assetId}</option>)}</select></label>
      <button type="submit" disabled={busy || !selectedCleaningRunId}>{t("research.runAnalysis")}</button>
    </form>}
    <h3>{t("research.analysisResults")}</h3>
    {study.analysisRuns.length === 0 && <p className="research-workspace__muted">{t("research.noAnalysisRuns")}</p>}
    {statusError && <p className="research-workspace__warning">{t("research.analysisStatusUnavailable", { message: statusError })}</p>}
    <ol>{study.analysisRuns.map((run) => {
      const status = analysisRunStatus(run.id, statuses, statusError);
      return <li key={run.id}><strong>v{run.version}</strong> · {study.assets.find((asset) => asset.id === run.assetId)?.filename ?? run.assetId} · {run.createdAt}
        <p className={status?.status === "current" ? "research-workspace__muted" : "research-workspace__warning"}>{t(status ? `research.analysisStatus_${status.status}` : "research.analysisStatus_checking")}{status?.reasons.length ? ` · ${status.reasons.map((reason) => t(`research.analysisReason_${reason}`)).join("; ")}` : ""}</p>
        <p className="research-workspace__muted">SHA-256 {run.resultSha256.slice(0, 12)}…</p>
        <div className="research-workspace__table-scroll"><table><thead><tr><th>{t("research.group")}</th><th>n</th><th>{t("research.mean")}</th><th>{t("research.sampleSd")}</th><th>{t("research.min")}</th><th>{t("research.max")}</th></tr></thead><tbody>
          <tr><th>{t("research.overall")}</th><td>{run.result.overall.n}</td><td>{numberLabel(run.result.overall.mean)}</td><td>{numberLabel(run.result.overall.sampleSd)}</td><td>{numberLabel(run.result.overall.min)}</td><td>{numberLabel(run.result.overall.max)}</td></tr>
          {run.result.groups.map((group) => <tr key={group.group}><th>{group.group}</th><td>{group.n}</td><td>{numberLabel(group.mean)}</td><td>{numberLabel(group.sampleSd)}</td><td>{numberLabel(group.min)}</td><td>{numberLabel(group.max)}</td></tr>)}
        </tbody></table></div>
      </li>;
    })}</ol>
  </section>;
}
