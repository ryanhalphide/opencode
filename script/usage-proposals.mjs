#!/usr/bin/env node
/**
 * Proposal-only usage analysis for OpenCode v2 diagnostics.
 *
 * Reads MODEL_ROUTER_V2_OBSERVATIONS JSONL streams, enforces each stream's own
 * evidence contract (contiguous seq, seal, dropped=failed=0), and writes a dated
 * markdown proposal. It never writes configuration, sends data, or applies a
 * change; a human decides whether a proposal is worth doing.
 *
 * Usage:
 *   node script/usage-proposals.mjs [--observations DIR] [--out DIR]
 *     [--threshold N] [--stdout] [--json]
 *
 * Exit codes: 0 analysis ran (with or without proposals), 2 unreadable input
 * or missing observations directory.
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const COMPONENTS = new Set(["verify", "rebase", "checks", "fast-forward", "phase-suite"]);
const EFFECTS = new Set([
  "change-set-capture", "finish-dispatch", "deferred-register", "verification-enqueue",
  "verification-settle", "annotation-delivery", "timing-row-write",
]);
const enumOf = (set, v) => (typeof v === "string" && set.has(v) ? v : "other");
const okish = (v) => v === null || v === undefined || /^(ok|success|succeeded|completed|pass(ed)?)$/i.test(String(v));

/** Parse one stream and decide whether it is evidence at all. */
export function readStream(text) {
  const rows = [];
  const faults = [];
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo += 1;
    if (!raw.trim()) continue;
    let row;
    try { row = JSON.parse(raw); } catch { faults.push(`line ${lineNo}: invalid JSON`); continue; }
    if (!isObj(row) || row.v !== 1 || !Number.isInteger(row.seq) || row.seq < 1) {
      faults.push(`line ${lineNo}: invalid row`);
      continue;
    }
    rows.push(row);
  }
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].seq !== i + 1) { faults.push(`seq gap at row ${i + 1}`); break; }
  }
  const end = rows.find((r) => r.kind === "end");
  const data = rows.filter((r) => r.kind !== "end");
  if (!end) faults.push("missing seal");
  else {
    const dropped = finite(end.dropped) ? end.dropped : finite(end.counts?.dropped) ? end.counts.dropped : null;
    const failed = finite(end.failed) ? end.failed : finite(end.counts?.failed) ? end.counts.failed : null;
    if (dropped === null || failed === null) faults.push("seal missing dropped/failed counts");
    else {
      if (dropped !== 0) faults.push(`dropped=${dropped}`);
      if (failed !== 0) faults.push(`failed=${failed}`);
    }
  }
  const at = data.map((r) => r.at).filter(finite);
  return {
    rows: data,
    end,
    faults,
    health: faults.length ? "insufficient" : "sealed-clean",
    window: at.length ? { from: Math.min(...at), to: Math.max(...at) } : null,
  };
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** Aggregate one clean stream into counts. Only enum-shaped values are read. */
function aggregate(stream) {
  const scheduler = { routeUnavailable: 0, launchGateDenied: 0, launchStepFailed: 0, forcedCapacity: 0, aborts: 0, writeConflicts: 0 };
  const service = { failures: new Map(), slow: new Map() };
  const completion = { failures: new Map(), attempts: new Map() };

  for (const row of stream.rows) {
    if (row.family === "scheduler") {
      const state = isObj(row.state) ? row.state : {};
      if (row.action === "route-unavailable") scheduler.routeUnavailable += 1;
      else if (row.action === "launch-gate" && state.ok === false) scheduler.launchGateDenied += 1;
      else if (row.action === "launch-step-end" && !okish(state.result)) scheduler.launchStepFailed += 1;
      else if (row.action === "capacity-reserve" && state.force === true) scheduler.forcedCapacity += 1;
      else if (row.action === "abort") scheduler.aborts += 1;
      if (Array.isArray(state.writeConflicts)) scheduler.writeConflicts += state.writeConflicts.length;
    } else if (row.family === "service" && row.action === "end") {
      const component = enumOf(COMPONENTS, row.component);
      if (row.result !== null && row.result !== undefined && !okish(row.result)) bump(service.failures, component);
      if (finite(row.durationMs) && row.durationMs > 120_000) bump(service.slow, component);
    } else if (row.family === "completion-effect") {
      if (row.outcome !== null && row.outcome !== undefined && !okish(row.outcome)) bump(completion.failures, enumOf(EFFECTS, row.effect));
      const key = [row.parentSessionID, row.callID, row.childSessionID].map(String).join("\u0000");
      bump(completion.attempts, key);
    }
  }
  const retries = [...completion.attempts.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
  return { scheduler, service, completion, retries };
}

function proposal(id, severity, count, detail, action) {
  return { id, severity, count, detail, action };
}

/** Turn aggregates into thresholded proposals; nothing is applied. */
export function deriveProposals(streams, threshold = 3) {
  const proposals = [];
  const notes = [];
  let clean = 0;

  for (const stream of streams) {
    if (stream.health !== "sealed-clean") {
      notes.push({ kind: "not-used", reason: stream.faults.join("; ") || "unsealed" });
      continue;
    }
    clean += 1;
    const a = aggregate(stream);
    const s = a.scheduler;

    if (s.routeUnavailable >= threshold) proposals.push(proposal(
      "route-unavailable", "warn", s.routeUnavailable,
      "The scheduler could not obtain a route for work.",
      "Review provider routing limits and fallback capacity for the affected lane."));
    if (s.launchGateDenied >= threshold) proposals.push(proposal(
      "launch-gate-denied", "warn", s.launchGateDenied,
      "Launch admission refused work repeatedly.",
      "Inspect the admission gate inputs: capacity, dependency readiness, and pause state."));
    if (s.launchStepFailed >= threshold) proposals.push(proposal(
      "launch-step-failed", "warn", s.launchStepFailed,
      "Launch steps ended with a non-ok result.",
      "Inspect the failing launch stage and its retry boundary."));
    if (s.forcedCapacity >= threshold) proposals.push(proposal(
      "forced-capacity", "warn", s.forcedCapacity,
      "Capacity reservations were forced past the normal limit.",
      "Lower concurrency or raise the provider limit; forcing hides saturation."));
    if (s.aborts >= threshold) proposals.push(proposal(
      "aborts", "info", s.aborts,
      "Tasks were aborted repeatedly.",
      "Identify whether cancellation came from a user action, a lease, or a timeout."));
    if (s.writeConflicts >= threshold) proposals.push(proposal(
      "write-conflicts", "warn", s.writeConflicts,
      "Concurrent writers conflicted over the same tasks.",
      "Reduce parallel writers or serialize the conflicting task group."));
    for (const [component, n] of a.service.failures) if (n >= threshold) proposals.push(proposal(
      `service-failure:${component}`, "warn", n,
      `The ${component} service stage reported non-ok results.`,
      `Inspect ${component} failures and their inputs before rerunning.`));
    for (const [component, n] of a.service.slow) if (n >= threshold) proposals.push(proposal(
      `service-slow:${component}`, "info", n,
      `The ${component} service stage exceeded 120 seconds.`,
      `Check whether ${component} latency is provider-bound or local.`));
    for (const [effect, n] of a.completion.failures) if (n >= threshold) proposals.push(proposal(
      `completion-failure:${effect}`, "warn", n,
      `Completion effect ${effect} reported non-ok outcomes.`,
      "Inspect the delivery path and whether a retry is bounded."));
    if (a.retries >= threshold) proposals.push(proposal(
      "retry-churn", "info", a.retries,
      "The same attempt identity was recorded more than once.",
      "Check whether retries are bounded and whether the first failure is retryable."));
  }

  if (clean === 0 && notes.length === 0) notes.push({ kind: "no-streams", reason: "no .jsonl streams found" });
  return { proposals, notes, clean, examined: streams.length };
}

export function render(report, now = new Date()) {
  const iso = now.toISOString();
  const lines = [
    `# OpenCode usage proposals — ${iso}`,
    "",
    "Proposal only. No setting, model, or source file was changed by this analysis.",
    "Input is the anonymized OpenCode v2 diagnostics stream; raw prompts, paths and credentials are never read.",
    "",
    "## Coverage",
    "",
    `- streams examined: ${report.examined}`,
    `- sealed and clean: ${report.clean}`,
    `- not used as evidence: ${report.notes.length}`,
  ];
  for (const note of report.notes) lines.push(`  - ${note.kind}: ${note.reason}`);
  lines.push("");
  if (report.proposals.length === 0) {
    lines.push("## Proposals", "", "No friction crossed the threshold.");
    if (report.clean === 0) lines.push("", "Next probe: enable sealed local diagnostics with `MODEL_ROUTER_V2_OBSERVATIONS` and collect real streams.");
  } else {
    lines.push("## Proposals", "");
    report.proposals
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .forEach((p, i) => {
        lines.push(`### ${i + 1}. ${p.id} (${p.count} occurrences, ${p.severity})`, "", p.detail, "", `Suggested action: ${p.action}`, "", "Status: not applied.", "");
      });
  }
  return lines.join("\n");
}

async function listStreams(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => join(dir, e.name))
    .sort();
}

export async function analyzeDir(dir, threshold = 3) {
  const files = await listStreams(dir);
  const streams = [];
  for (const file of files) streams.push(readStream(await readFile(file, "utf8")));
  return deriveProposals(streams, threshold);
}

async function main(argv) {
  const args = { observations: process.env.MODEL_ROUTER_V2_OBSERVATIONS ?? null, out: null, threshold: 3, stdout: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--observations") args.observations = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--stdout") args.stdout = true;
    else if (a === "--json") args.json = true;
    else { process.stderr.write(`unknown argument: ${a}\n`); process.exit(2); }
  }
  if (!args.observations) {
    process.stderr.write("missing --observations or MODEL_ROUTER_V2_OBSERVATIONS\n");
    process.exit(2);
  }
  if (!Number.isInteger(args.threshold) || args.threshold < 1) {
    process.stderr.write("--threshold must be a positive integer\n");
    process.exit(2);
  }
  let report;
  try { report = await analyzeDir(args.observations, args.threshold); }
  catch (error) {
    process.stderr.write(`cannot read observations: ${error.message}\n`);
    process.exit(2);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const text = render(report, new Date());
  if (args.stdout) { process.stdout.write(`${text}\n`); return; }
  const out = args.out ?? join(homedir(), ".local", "share", "opencode", "usage-proposals");
  await mkdir(out, { recursive: true });
  const file = join(out, `usage-proposals-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  await writeFile(file, `${text}\n`, { flag: "wx" });
  process.stdout.write(`${file}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
