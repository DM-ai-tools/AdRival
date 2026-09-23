"use client";

import { useEffect, useMemo, useState } from "react";
import type { CompetitorRecord, RecreatedLandingPage } from "@/lib/types";
import type {
  CanonicalContent,
  ContentPack,
  ContentSection,
  StructuredItem,
} from "@/lib/pipeline/content/model";
import { isExtractedSource, isPurposeSummary } from "@/lib/pipeline/content/pageIntent";

type SaveState = "unsaved" | "saving" | "saved" | "failed";

export function ContentReviewWorkspace({
  competitorId,
  page,
  canEdit,
  onUpdated,
}: {
  competitorId: string;
  page: RecreatedLandingPage;
  canEdit: boolean;
  onUpdated: (competitor: CompetitorRecord) => void;
}) {
  const initial = page.contentPack;
  const [pack, setPack] = useState<ContentPack | null>(initial || null);
  const [selected, setSelected] = useState(initial?.canonical.sections[0]?.id || "");
  const [serverRevision, setServerRevision] = useState(initial?.canonical.revision ?? 0);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [mobilePane, setMobilePane] = useState<"ours" | "competitor">("ours");
  const [busy, setBusy] = useState(false);
  const [feedbackBySection, setFeedbackBySection] = useState<Record<string, string>>({});

  useEffect(() => {
    const incoming = page.contentPack;
    if (!incoming || saveState === "unsaved" || saveState === "saving") return;
    const hasCopy = (candidate: ContentPack) =>
      candidate.canonical.sections.some(
        (section) => section.paragraphs.some((paragraph) => paragraph.trim()) || section.items.length > 0,
      );
    if (pack && hasCopy(pack)) return;
    if (hasCopy(incoming)) setPack(incoming);
  }, [page.contentPack, pack, saveState]);

  const canonical = pack?.canonical;
  const section = canonical?.sections.find((item) => item.id === selected) || canonical?.sections[0];
  const source = pack?.competitor.sections.find((item) => item.id === section?.competitorSectionId);
  const issues = canonical?.issues || [];
  const critical = issues.filter((item) => item.severity === "critical");

  const outdated =
    page.designContentRevision != null &&
    page.contentPack?.approvedSnapshot?.approvedRevision != null &&
    page.designContentRevision !== page.contentPack.approvedSnapshot.approvedRevision;

  const evidenceFor = useMemo(() => {
    const facts = pack?.evidence.facts || [];
    return (ids: string[]) => {
      const seen = new Set<string>();
      return facts.filter((fact) => {
        if (!ids.includes(fact.id) || seen.has(fact.id)) return false;
        seen.add(fact.id);
        return true;
      });
    };
  }, [pack]);

  function updateSection(id: string, patch: Partial<ContentSection>) {
    if (!pack || !canEdit) return;
    setSaveState("unsaved");
    setPack({
      ...pack,
      canonical: {
        ...pack.canonical,
        sections: pack.canonical.sections.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        ),
      },
    });
  }

  async function post(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    if (action === "save_content") setSaveState("saving");
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitorId, action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      const next = data.competitor as CompetitorRecord;
      const nextRevision = next.recreatedPage?.contentPack?.canonical.revision;
      if (typeof nextRevision === "number") setServerRevision(nextRevision);
      setPack(next.recreatedPage?.contentPack || null);
      setSaveState("saved");
      onUpdated(next);
    } catch (err) {
      setSaveState("failed");
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function save(current = pack) {
    if (!current || !canEdit) return;
    await post("save_content", {
      canonical: current.canonical,
      expectedRevision: serverRevision,
    });
  }

  if (!pack || !canonical || pack.legacy) {
    return (
      <section className="review-workspace panel">
        <p>
          This is an older draft. It has not been checked against client evidence and cannot
          be approved or built. Regenerate content first.
        </p>
      </section>
    );
  }

  return (
    <section className="review-workspace">
      <header className="review-toolbar panel">
        <div>
          <h2>Review content</h2>
          <p className="muted">
            Revision {canonical.revision}
            {canonical.approved ? " · approved" : " · not approved"}
            {page.designContentRevision != null
              ? ` · design uses revision ${page.designContentRevision}`
              : ""}
            {outdated ? " · design is outdated" : ""}
          </p>
        </div>
        <div className="review-toolbar-actions">
          <span className={`review-save is-${saveState}`}>
            {saveState === "unsaved" ? "Unsaved" : saveState === "saving" ? "Saving…" : saveState === "failed" ? "Save failed" : "Saved"}
          </span>
          <button type="button" className="ghost-btn" disabled={!canEdit || busy} onClick={() => void save()}>
            Save edits
          </button>
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => setPreview((value) => !value)}>
            {preview ? "Comparison" : "Client preview"}
          </button>
          <button
            type="button"
            className="search-btn"
            disabled={!canEdit || busy || critical.length > 0}
            onClick={() => void post("approve_content", { expectedRevision: serverRevision })}
          >
            Approve content
          </button>
        </div>
      </header>

      {critical.length > 0 ? (
        <div className="review-summary panel" role="alert">
          <strong>{critical.length} critical issue{critical.length === 1 ? "" : "s"}.</strong> Approval is blocked. Saving is not confirmation.
          <ul>
            {critical.map((item) => (
              <li key={item.id}>
                <button type="button" className="review-issue-jump" onClick={() => item.sectionId && setSelected(item.sectionId)}>
                  {item.sectionId || "Page"}: {item.message} {item.remedy}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="error-text">{error}</p> : null}
      <ServiceBrief pack={pack} canEdit={canEdit} busy={busy} onSave={(edit) => void post("update_intent", { expectedRevision: serverRevision, ...edit })} />
      {pack.inventory ? (
        <section className="review-map panel">
          <h3>Page map</h3>
          <p className="muted">
            {pack.inventory.visionUsed ? "Visual regions were reconciled with rendered text." : "Visual analysis did not complete."} Capture is not treated as complete just because analysis returned a list.
          </p>
          <ol>
            {pack.inventory.sections.map((item) => (
              <li key={item.id}>
                <strong>{item.sourceHeading || item.internalLabel}</strong>
                <span>{item.textKind === "summary" ? " analysis summary" : " rendered"}{item.gaps[0] ? ` · ${item.gaps[0]}` : ""}</span>
              </li>
            ))}
          </ol>
          {pack.inventory.gaps.slice(0, 3).map((gap) => (
            <p key={gap} className="muted">{gap}</p>
          ))}
        </section>
      ) : null}

      {preview ? (
        <article className="review-preview panel">
          <h3>{canonical.meta.title}</h3>
          <p>{canonical.meta.description}</p>
          {canonical.sections
            .filter((item) => item.decision !== "omit")
            .map((item) => (
              <section key={item.id}>
                <h4>{item.heading}</h4>
                {item.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </section>
            ))}
        </article>
      ) : (
        <div className="review-layout">
          <nav className="review-nav panel" aria-label="Sections">
            {canonical.sections.map((item, index) => {
              const source = pack.competitor.sections.find((section) => section.id === item.competitorSectionId);
              const status = reviewStatus(item, isExtractedSource(source) ? "source" : "summary");
              const issueCount = item.issues.length;
              return (
              <button
                key={item.id}
                type="button"
                className={item.id === section?.id ? "is-active" : ""}
                onClick={() => setSelected(item.id)}
              >
                <span>{index + 1}</span>
                {item.heading || item.purpose}
                <small>{status}{issueCount ? ` · ${issueCount}` : ""}</small>
              </button>
              );
            })}
            {canEdit ? (
              <button
                type="button"
                onClick={() => {
                  const id = `sec-new-${Date.now()}`;
                  setSaveState("unsaved");
                  setPack({
                    ...pack,
                    canonical: {
                      ...canonical,
                      sections: [
                        ...canonical.sections,
                        {
                          id,
                          decision: "replace",
                          decisionReason: "Added in review. No direct competitor equivalent.",
                          purpose: "Additional client section",
                          competitorSectionId: null,
                          heading: "New section",
                          paragraphs: [],
                          items: [],
                          evidenceIds: [],
                          locked: false,
                          issues: [],
                        },
                      ],
                    },
                  });
                  setSelected(id);
                }}
              >
                Add section
              </button>
            ) : null}
          </nav>
          <div className="review-panes">
            <div className="review-mobile-toggle">
              <button type="button" className={mobilePane === "competitor" ? "is-active" : ""} onClick={() => setMobilePane("competitor")}>
                Competitor
              </button>
              <button type="button" className={mobilePane === "ours" ? "is-active" : ""} onClick={() => setMobilePane("ours")}>
                Our content
              </button>
            </div>
            {section ? (
              <SectionPair
                section={section}
                sourceHeading={source?.heading || ""}
                sourceText={isExtractedSource(source) ? source?.sourceText || "" : ""}
                sourceComponents={(source?.components || []).filter((component) => !isPurposeSummary(component.text))}
                sourceUrl={source?.sourceUrl || pack.competitor.sourceUrl}
                sourceKind={isExtractedSource(source) ? "source" : "summary"}
                sourceGaps={isExtractedSource(source) ? [] : ["Exact page text was not captured for this section. A purpose summary is not source copy."]}
                mobilePane={mobilePane}
                canEdit={canEdit}
                evidence={evidenceFor(section.evidenceIds)}
                onChange={(patch) => updateSection(section.id, patch)}
                onRegenerate={() =>
                  void post("regenerate_section", {
                    sectionId: section.id,
                    expectedRevision: serverRevision,
                    userFeedback: feedbackBySection[section.id] || "",
                  })
                }
                onLock={() => updateSection(section.id, { locked: !section.locked })}
                onUndo={() => void post("undo_content", { expectedRevision: serverRevision })}
                onConfirm={() =>
                  void post("confirm_fact", {
                    sectionId: section.id,
                    value: section.heading || section.paragraphs[0] || "",
                  })
                }
                onMove={(direction) => {
                  const index = canonical.sections.findIndex((item) => item.id === section.id);
                  const next = index + direction;
                  if (index < 0 || next < 0 || next >= canonical.sections.length) return;
                  const sections = [...canonical.sections];
                  const [moved] = sections.splice(index, 1);
                  sections.splice(next, 0, moved);
                  setSaveState("unsaved");
                  setPack({ ...pack, canonical: { ...canonical, sections } });
                }}
                feedback={feedbackBySection[section.id] || ""}
                onFeedback={(value) => setFeedbackBySection((current) => ({ ...current, [section.id]: value }))}
                busy={busy}
              />
            ) : null}
          </div>
        </div>
      )}

      {pack.proposal ? (
        <aside className="review-proposal panel">
          <h3>Proposed section change</h3>
          <p>Review this rewrite before it replaces the current section. Other sections are unchanged.</p>
          <p><strong>{pack.proposal.section.heading}</strong></p>
          {pack.proposal.section.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
          <div className="review-toolbar-actions">
            <button type="button" className="search-btn" disabled={!canEdit || busy} onClick={() => void post("accept_proposal")}>
              Accept proposal
            </button>
            <button type="button" className="ghost-btn" disabled={!canEdit || busy} onClick={() => void post("discard_proposal")}>
              Discard
            </button>
          </div>
        </aside>
      ) : null}

      <MetaEditor canonical={canonical} canEdit={canEdit} onChange={(meta) => {
        setSaveState("unsaved");
        setPack({ ...pack, canonical: { ...canonical, meta } });
      }} />
    </section>
  );
}

function ServiceBrief({
  pack,
  canEdit,
  busy,
  onSave,
}: {
  pack: ContentPack;
  canEdit: boolean;
  busy: boolean;
  onSave: (edit: { primaryService?: string; offerConcept?: string; confirmedTerms?: string[] }) => void;
}) {
  const intent = pack.intent;
  const [service, setService] = useState(intent?.primaryService || "");
  const [offer, setOffer] = useState(intent?.offerConcept || "");
  if (!intent) {
    return (
      <section className="review-brief panel">
        <p>This draft has no service brief. It cannot be reused as a finished page. Regenerate content so the competitor page sets the topic.</p>
      </section>
    );
  }
  return (
    <section className="review-brief panel">
      <p><strong>Recreating:</strong> {intent.primaryService}</p>
      <p><strong>Offer approach:</strong> {intent.offerConcept} · {intent.offerMode === "proposed" ? "proposed, not a confirmed client offer" : "using confirmed client terms"}</p>
      <p><strong>For:</strong> {pack.canonical.clientName}</p>
      {intent.clientMatch === "no" ? <p className="error-text">The client site does not establish this service. The topic will not be replaced with another client service.</p> : null}
      {intent.ambiguous ? <p className="muted">Unclear service. Choose one instead of using the homepage: {intent.options.join(" or ")}.</p> : null}
      {intent.usingSummaryOnly ? <p className="muted">This brief used an analysis summary because rendered page text was missing.</p> : null}
      <label>
        Detected service
        <input disabled={!canEdit} value={service} onChange={(event) => setService(event.target.value)} />
      </label>
      <label>
        Offer approach
        <input disabled={!canEdit} value={offer} onChange={(event) => setOffer(event.target.value)} />
      </label>
      <div className="review-toolbar-actions">
        <button type="button" className="ghost-btn" disabled={!canEdit || busy} onClick={() => onSave({ primaryService: service, offerConcept: offer })}>
          Save brief
        </button>
        {intent.offerMode === "proposed" ? (
          <button type="button" className="ghost-btn" disabled={!canEdit || busy} onClick={() => onSave({ confirmedTerms: [offer].filter(Boolean) })}>
            Confirm offer concept
          </button>
        ) : null}
      </div>
    </section>
  );
}

function reviewStatus(section: ContentSection, sourceKind: string): string {
  if (section.decision === "omit") return "Omitted";
  if (sourceKind !== "source") return "Source incomplete";
  if (section.decision === "needs_input") return "Needs evidence";
  if ((section.fields || []).some((field) => field.disposition !== "omit" && !field.text.trim() && field.items.length === 0)) return "Drafting";
  if (!section.paragraphs.some((paragraph) => paragraph.trim()) && section.items.length === 0) return "Drafting";
  if (section.issues.some((issue) => issue.severity === "critical")) return "Needs evidence";
  return "Complete";
}

function fitNote(text: string, kind: string): string {
  const limit = kind === "cta" ? 28 : kind === "headline" ? 72 : 360;
  const state = text.length > limit ? "longer than the approximate slot" : "within the approximate slot";
  return `Approximate content preview, not the final design: ${state}.`;
}

function SectionPair(props: {
  section: ContentSection;
  sourceHeading: string;
  sourceText: string;
  sourceComponents: Array<{ id: string; kind: string; text: string; items: string[] }>;
  sourceUrl: string;
  sourceKind: string;
  sourceGaps: string[];
  mobilePane: "ours" | "competitor";
  canEdit: boolean;
  evidence: ContentPack["evidence"]["facts"];
  onChange: (patch: Partial<ContentSection>) => void;
  onRegenerate: () => void;
  onLock: () => void;
  onUndo: () => void;
  onConfirm: () => void;
  onMove: (direction: -1 | 1) => void;
  feedback: string;
  onFeedback: (value: string) => void;
  busy: boolean;
}) {
  const omitted = props.section.decision === "omit";
  return (
    <div className={`review-pair pane-${props.mobilePane}`}>
      <article className="review-card review-source">
        <p className="review-kicker">
          Competitor · read only · {props.sourceKind === "summary" ? "analysis summary, not page text" : "extracted page text"}
        </p>
        <details>
          <summary>Section purpose</summary>
          <p>{props.section.purpose}</p>
        </details>
        <h3>{props.sourceHeading || "No source heading"}</h3>
        {props.sourceComponents.length ? (
          <ul className="review-components">
            {props.sourceComponents.map((component) => (
              <li key={component.id}>
                <small>{component.kind}</small>
                <p>{component.text || component.items.join(", ") || "No extracted text"}</p>
              </li>
            ))}
          </ul>
        ) : props.sourceText ? <p>{props.sourceText}</p> : <p>No rendered text was captured for this section.</p>}
        {props.sourceGaps.map((gap) => <p key={gap} className="muted">{gap}</p>)}
        <a href={props.sourceUrl} target="_blank" rel="noreferrer">Source page</a>
      </article>
      <article className="review-card review-ours">
        <p className="review-kicker">
          Our content · {props.section.decision.replace("_", " ")} · {reviewStatus(props.section, props.sourceKind)}
        </p>
        {omitted ? (
          <p>{props.section.decisionReason}</p>
        ) : (
          <>
            <label>
              Heading
              <input
                disabled={!props.canEdit}
                value={props.section.heading}
                onChange={(event) => props.onChange({ heading: event.target.value })}
              />
            </label>
            {(props.section.fields || []).length ? (
              (props.section.fields || []).map((field) => (
                <label key={field.id}>
                  {field.kind}{field.disposition === "omit" ? " · omitted" : ""}
                  {field.disposition === "omit" ? (
                    <p className="muted">{field.reason}</p>
                  ) : field.kind === "cta" || field.kind === "headline" ? (
                    <input
                      disabled={!props.canEdit}
                      value={field.text}
                      onChange={(event) => props.onChange({
                        fields: (props.section.fields || []).map((item) => item.id === field.id ? { ...item, text: event.target.value } : item),
                      })}
                    />
                  ) : (
                    <textarea
                      className="review-grow"
                      rows={3}
                      disabled={!props.canEdit}
                      value={field.text}
                      onChange={(event) => props.onChange({
                        fields: (props.section.fields || []).map((item) => item.id === field.id ? { ...item, text: event.target.value } : item),
                      })}
                    />
                  )}
                  <p className="muted">{fitNote(field.text, field.kind)}</p>
                </label>
              ))
            ) : (
              <label>
                Copy
                <textarea
                  className="review-grow"
                  rows={8}
                  disabled={!props.canEdit}
                  value={props.section.paragraphs.join("\n\n")}
                  onChange={(event) =>
                    props.onChange({
                      paragraphs: event.target.value.split(/\n\n+/).filter(Boolean),
                    })
                  }
                />
              </label>
            )}
            <ItemEditor
              items={props.section.items}
              canEdit={props.canEdit}
              onChange={(items) => props.onChange({ items })}
            />
          </>
        )}
        <p className="muted">{props.section.decisionReason}</p>
        <p className="muted">{fitNote(props.section.paragraphs.join(" "), "paragraph")}</p>
        {props.section.issues.map((issue) => (
          <p key={issue.id} className={issue.severity === "critical" ? "error-text" : "muted"}>
            {issue.message} {issue.remedy}
          </p>
        ))}
        {props.evidence.length ? (
          <details>
            <summary>Evidence ({props.evidence.length})</summary>
            {props.evidence.map((fact) => (
              <p key={fact.id}>
                {fact.status === "user_confirmed" ? "User confirmed" : "Stated on site"} · {fact.category} · {fact.value}
                {fact.confirmedBy ? ` · ${fact.confirmedBy}` : ""} · {fact.sourceUrl}
              </p>
            ))}
          </details>
        ) : (
          <p className="muted">No client evidence is attached to this section.</p>
        )}
        <label>
          Section feedback
          <textarea
            className="review-grow"
            rows={2}
            disabled={!props.canEdit}
            value={props.feedback}
            onChange={(event) => props.onFeedback(event.target.value)}
          />
        </label>
        <div className="review-toolbar-actions">
          <button type="button" className="ghost-btn" disabled={!props.canEdit || props.busy || props.section.locked} onClick={props.onRegenerate}>
            Regenerate section
          </button>
          <button type="button" className="ghost-btn" disabled={!props.canEdit} onClick={props.onLock}>
            {props.section.locked ? "Unlock" : "Lock"} section
          </button>
          <button type="button" className="ghost-btn" disabled={!props.canEdit || props.busy} onClick={props.onUndo}>
            Undo
          </button>
          <button type="button" className="ghost-btn" disabled={!props.canEdit} onClick={() => props.onMove(-1)}>
            Move up
          </button>
          <button type="button" className="ghost-btn" disabled={!props.canEdit} onClick={() => props.onMove(1)}>
            Move down
          </button>
          {props.section.issues.some((issue) => issue.severity === "critical") ? (
            <button type="button" className="ghost-btn" disabled={!props.canEdit || props.busy} onClick={props.onConfirm}>
              Confirm claim
            </button>
          ) : null}
        </div>
      </article>
    </div>
  );
}

function ItemEditor({
  items,
  canEdit,
  onChange,
}: {
  items: StructuredItem[];
  canEdit: boolean;
  onChange: (items: StructuredItem[]) => void;
}) {
  return (
    <div className="review-items">
      {items.map((item) => (
        <div key={item.id} className="review-item">
          <input
            disabled={!canEdit}
            value={item.label}
            onChange={(event) =>
              onChange(items.map((row) => (row.id === item.id ? { ...row, label: event.target.value } : row)))
            }
          />
          <button type="button" className="ghost-btn" disabled={!canEdit} onClick={() => onChange(items.filter((row) => row.id !== item.id))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="ghost-btn"
        disabled={!canEdit}
        onClick={() =>
          onChange([
            ...items,
            { id: `item-${Date.now()}`, kind: "faq", label: "", detail: "", evidenceIds: [] },
          ])
        }
      >
        Add item
      </button>
    </div>
  );
}

function MetaEditor({
  canonical,
  canEdit,
  onChange,
}: {
  canonical: CanonicalContent;
  canEdit: boolean;
  onChange: (meta: CanonicalContent["meta"]) => void;
}) {
  return (
    <div className="review-meta panel">
      <label>
        Page title
        <input
          disabled={!canEdit}
          value={canonical.meta.title}
          onChange={(event) => onChange({ ...canonical.meta, title: event.target.value })}
        />
      </label>
      <label>
        Meta description
        <textarea
          className="review-grow"
          rows={2}
          disabled={!canEdit}
          value={canonical.meta.description}
          onChange={(event) => onChange({ ...canonical.meta, description: event.target.value })}
        />
      </label>
    </div>
  );
}
