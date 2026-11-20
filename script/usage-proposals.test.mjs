import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readStream, deriveProposals, render, analyzeDir } from "./usage-proposals.mjs";

const BASE = 1_700_000_000_000;
const row = (seq, family, extra = {}) => ({ v: 1, stream: "fixture", seq, at: BASE + seq * 1000, family, ...extra });
const seal = (seq, extra = {}) => ({
  v: 1, stream: "fixture", seq, at: BASE + seq * 1000, kind: "end",
  attempted: seq - 1, written: seq - 1, dropped: 0, failed: 0, ...extra,
});
const text = (rows) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const scheduler = (seq, action, state = {}) => row(seq, "scheduler", { action, state });

test("clean stream below threshold produces no proposal", () => {
  const s = readStream(text([scheduler(1, "route-unavailable"), scheduler(2, "route-unavailable"), seal(3)]));
  assert.equal(s.health, "sealed-clean");
  const report = deriveProposals([s], 3);
  assert.equal(report.proposals.length, 0);
  assert.equal(report.clean, 1);
});

test("three route-unavailable rows cross the threshold", () => {
  const s = readStream(text([1, 2, 3].map((n) => scheduler(n, "route-unavailable")).concat(seal(4))));
  const report = deriveProposals([s], 3);
  assert.equal(report.proposals.length, 1);
  assert.equal(report.proposals[0].id, "route-unavailable");
  assert.equal(report.proposals[0].count, 3);
});

test("injected text never reaches the proposal", () => {
  const rows = [1, 2, 3].map((n) => row(n, "service", {
    action: "end", component: "SECRETCOMPONENT", result: "failed", durationMs: 1000,
  }));
  rows.push(scheduler(4, "route-unavailable", { prompt: "SECRET-PROMPT", note: "SECRET-NOTE", writeConflicts: [] }));
  rows.push(seal(5));
  const report = deriveProposals([readStream(text(rows))], 3);
  const out = render(report, new Date("2026-11-20T12:00:00.000Z"));
  assert.equal(out.includes("SECRET"), false);
  assert.ok(report.proposals.some((p) => p.id === "service-failure:other"));
});

test("missing seal is not evidence", () => {
  const s = readStream(text([scheduler(1, "route-unavailable")]));
  assert.equal(s.health, "insufficient");
  const report = deriveProposals([s], 3);
  assert.equal(report.clean, 0);
  assert.equal(report.proposals.length, 0);
  assert.match(report.notes[0].reason, /missing seal/);
});

test("sequence gap is not evidence", () => {
  const s = readStream(text([scheduler(1, "route-unavailable"), scheduler(3, "route-unavailable"), seal(3)]));
  assert.equal(s.health, "insufficient");
  assert.match(s.faults.join(" "), /seq gap/);
});

test("dropped rows make the stream insufficient", () => {
  const s = readStream(text([scheduler(1, "abort"), seal(2, { dropped: 1 })]));
  assert.equal(s.health, "insufficient");
  assert.match(s.faults.join(" "), /dropped=1/);
});

test("service failures and slow stages are proposed separately", () => {
  const rows = [1, 2, 3].map((n) => row(n, "service", { action: "end", component: "verify", result: "failed", durationMs: 5000 }));
  rows.push(...[4, 5, 6].map((n) => row(n, "service", { action: "end", component: "checks", result: "ok", durationMs: 200_000 })));
  rows.push(seal(7));
  const report = deriveProposals([readStream(text(rows))], 3);
  assert.ok(report.proposals.some((p) => p.id === "service-failure:verify"));
  assert.ok(report.proposals.some((p) => p.id === "service-slow:checks"));
});

test("retry churn counts excess attempts without exposing identities", () => {
  const rows = [];
  let seq = 1;
  for (const id of ["a", "b", "c"]) {
    for (let n = 0; n < 2; n += 1) {
      rows.push(row(seq, "completion-effect", {
        effect: "finish-dispatch", source: "foreground-result", outcome: "ok",
        parentSessionID: "parent-SECRET", callID: id, childSessionID: "child-SECRET",
      }));
      seq += 1;
    }
  }
  rows.push(seal(seq));
  const report = deriveProposals([readStream(text(rows))], 3);
  const retry = report.proposals.find((p) => p.id === "retry-churn");
  assert.ok(retry);
  assert.equal(retry.count, 3);
  assert.equal(render(report).includes("SECRET"), false);
});

test("render is deterministic for a fixed timestamp", () => {
  const s = readStream(text([1, 2, 3].map((n) => scheduler(n, "abort")).concat(seal(4))));
  const report = deriveProposals([s], 3);
  const a = render(report, new Date("2026-11-20T12:00:00.000Z"));
  const b = render(report, new Date("2026-11-20T12:00:00.000Z"));
  assert.equal(a, b);
  assert.match(a, /2026-11-20T12:00:00\.000Z/);
  assert.match(a, /not applied/);
});

test("analyzeDir reads healthy and broken streams side by side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-proposals-"));
  try {
    await writeFile(join(dir, "a.jsonl"), text([1, 2, 3].map((n) => scheduler(n, "route-unavailable")).concat(seal(4))));
    await writeFile(join(dir, "b.jsonl"), text([scheduler(1, "abort")]));
    const report = await analyzeDir(dir, 3);
    assert.equal(report.examined, 2);
    assert.equal(report.clean, 1);
    assert.equal(report.proposals.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
