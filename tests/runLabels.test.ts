import test from "node:test";
import assert from "node:assert/strict";
import { filterRuns, formatRunDate, groupRuns, type RunItem } from "../src/lib/pipeline/awareness/runLabels";

const now = new Date("2026-10-22T12:00:00");

test("formatRunDate gives a label and relative text", () => {
  const today = formatRunDate("2026-10-22T09:00:00", now);
  assert.equal(today.relative, "today");
  assert.match(today.label, /2026/);
  assert.equal(formatRunDate("2026-10-21T09:00:00", now).relative, "1 day ago");
  assert.equal(formatRunDate("2026-09-28T14:05:00", now).relative, "24 days ago");
  assert.match(formatRunDate("2026-09-28T14:05:00", now).label, /28/);
});

test("formatRunDate returns empty strings for missing or invalid input", () => {
  assert.deepEqual(formatRunDate(null, now), { label: "", relative: "" });
  assert.deepEqual(formatRunDate(undefined, now), { label: "", relative: "" });
  assert.deepEqual(formatRunDate("not a date", now), { label: "", relative: "" });
});

const run = (id: string, kind: "search" | "lookup", title: string, createdAt: string, subtitle?: string): RunItem => ({
  id,
  kind,
  title,
  status: "completed",
  createdAt,
  updatedAt: createdAt,
  count: 3,
  countLabel: kind === "search" ? "competitors" : "ads",
  subtitle,
});

test("groupRuns groups, sorts newest first and omits empty groups", () => {
  const runs = [
    run("a", "search", "old", "2026-09-01T10:00:00"),
    run("b", "lookup", "look", "2026-10-01T10:00:00"),
    run("c", "search", "new", "2026-10-10T10:00:00"),
  ];
  const groups = groupRuns(runs);
  assert.deepEqual(groups.map((g) => g.heading), ["Keyword searches", "Competitor lookups"]);
  assert.deepEqual(groups[0].runs.map((r) => r.id), ["c", "a"]);
  assert.deepEqual(groupRuns([runs[0]]).map((g) => g.heading), ["Keyword searches"]);
  assert.deepEqual(groupRuns([]), []);
});

test("filterRuns matches title, subtitle and date text", () => {
  const runs = [
    run("a", "search", "Dentist London", "2026-09-28T14:05:00", "Acme Ltd"),
    run("b", "lookup", "Plumbers", "2026-10-10T10:00:00"),
  ];
  assert.equal(filterRuns(runs, "").length, 2);
  assert.deepEqual(filterRuns(runs, "dentist").map((r) => r.id), ["a"]);
  assert.deepEqual(filterRuns(runs, "ACME").map((r) => r.id), ["a"]);
  const label = formatRunDate("2026-10-10T10:00:00").label;
  assert.deepEqual(filterRuns(runs, label.slice(0, 6)).map((r) => r.id).includes("b"), true);
  assert.equal(filterRuns(runs, "zzz").length, 0);
});
