"use client";

import { useEffect, useState } from "react";
import type { CompetitorRecord, SearchJob } from "@/lib/types";

type ResultsView = "website" | "preview" | "brand" | "offers";
type StepKey = "setup" | "find" | "review" | "offers" | "recreate";
type StepState = "done" | "current" | "todo";

const STEPS: Array<{ key: StepKey; label: string }> = [
  { key: "setup", label: "Set up search" },
  { key: "find", label: "Find competitors" },
  { key: "review", label: "Review competitors" },
  { key: "offers", label: "Offers dashboard" },
  { key: "recreate", label: "Recreate a page" },
];

/**
 * Where the user is in a keyword search, start to end, and what to do next.
 * Each finished or next step can be clicked to go there.
 */
export function JourneySteps({
  job,
  competitors,
  view,
  onView,
  onSetup,
}: {
  job: SearchJob | null;
  competitors: CompetitorRecord[];
  view: ResultsView;
  onView: (view: ResultsView) => void;
  /** Go to the search form; omitted where there is no form (History). */
  onSetup?: () => void;
}) {
  // "Recreate a page" happens from the competitor list; remember that the
  // user asked for it so the hint explains how.
  const [recreateFocus, setRecreateFocus] = useState(false);
  useEffect(() => {
    if (view !== "preview") setRecreateFocus(false);
  }, [view]);

  const running = job?.status === "running";
  const finished = Boolean(job) && !running;
  const found = competitors.length || job?.progress?.accepted || 0;
  const offersDone = job?.offersReport?.status === "completed";
  const offersRunning = job?.progress?.stage === "analyzing_offers";
  const recreated = competitors.some((c) => c.recreatedPage?.status === "completed" && c.recreatedPage.html);
  const analysed = competitors.some((c) => c.pageAnalysis?.status === "completed");

  let current: StepKey;
  if (!job) current = "setup";
  else if (running && !offersRunning) current = "find";
  else if (view === "offers") current = "offers";
  else if (recreateFocus) current = "recreate";
  else current = "review";

  const order = STEPS.map((s) => s.key);
  const state = (key: StepKey): StepState => {
    if (key === current) return "current";
    if (key === "setup") return job ? "done" : "todo";
    if (key === "find") return finished ? "done" : "todo";
    if (key === "review") return finished && (offersDone || order.indexOf(current) > order.indexOf("review")) ? "done" : "todo";
    if (key === "offers") return offersDone ? "done" : "todo";
    return recreated ? "done" : "todo";
  };
  const reachable = (key: StepKey): boolean => {
    if (key === "setup") return Boolean(onSetup);
    if (key === "find") return false;
    return finished && found > 0;
  };
  const go = (key: StepKey) => {
    if (key === "setup") onSetup?.();
    else if (key === "review") {
      setRecreateFocus(false);
      onView("preview");
    } else if (key === "offers") onView("offers");
    else if (key === "recreate") {
      setRecreateFocus(true);
      onView("preview");
    }
  };

  let hint: string;
  let next: { key: StepKey; label: string } | null = null;
  if (!job) {
    hint = "Add your client's website and keywords below, then press Search.";
  } else if (running && !offersRunning) {
    hint = "Finding competitors. Progress is shown below.";
  } else if (finished && !found) {
    hint = "No competitors were found. Try broader keywords or a wider location, then search again.";
    if (onSetup) next = { key: "setup", label: "Change the search" };
  } else if (current === "review") {
    hint = offersDone
      ? "Your competitors are listed below. The offers dashboard is ready."
      : `Check the ${found} competitors below and remove any that don't fit. Then build the offers dashboard.`;
    next = { key: "offers", label: offersDone ? "Open offers dashboard" : "Next: offers dashboard" };
  } else if (current === "offers") {
    hint = offersRunning
      ? "Building the offers dashboard. It keeps running if you leave the page."
      : offersDone
        ? "Start with Insights for the best offers. When you find a landing page worth copying, recreate it for your brand."
        : "Pick the competitors to include and build the dashboard to see their offers, ladders and best ads.";
    if (offersDone) next = { key: "recreate", label: "Next: recreate a page" };
  } else {
    hint = analysed
      ? "Pick a competitor below and press “Recreate for my brand”. Nothing is charged until you press “Create my page” on the next screen."
      : "Pick a competitor below and press “Get offer & page details”. Then press “Recreate for my brand”.";
  }

  return (
    <nav className="journey" aria-label="Steps">
      <ol className="journey-steps">
        {STEPS.map((step, i) => {
          const s = state(step.key);
          const clickable = reachable(step.key) && s !== "current";
          const body = (
            <>
              <span className="journey-dot" aria-hidden="true">
                {s === "done" ? "✓" : i + 1}
              </span>
              <span className="journey-label">{step.label}</span>
            </>
          );
          return (
            <li key={step.key} className={`journey-step is-${s}`} aria-current={s === "current" ? "step" : undefined}>
              {clickable ? (
                <button type="button" onClick={() => go(step.key)}>
                  {body}
                </button>
              ) : (
                <span className="journey-static">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="journey-hint">
        <p>{hint}</p>
        {next ? (
          <button type="button" className="search-btn journey-next" onClick={() => go(next.key)}>
            {next.label} →
          </button>
        ) : null}
      </div>
    </nav>
  );
}
