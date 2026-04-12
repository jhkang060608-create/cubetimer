#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getDefaultPattern } from "../solver/context.js";
import { solve3x3RouxFromPattern } from "../solver/roux3x3.js";
import { ROUX_CASE_DB } from "../solver/rouxCaseDb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    input: path.join(rootDir, "vendor-data", "reco", "reco-all-3x3-gte100-details.json"),
    output: path.join(rootDir, "vendor-data", "reco", "roux-recovery-report.json"),
    limit: 100,
    offset: 0,
    deadlineMs: 30000,
    uniqueScrambles: true,
    sampleFailures: 12,
    sampleRecoveries: 12,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }

    const [flag, inlineValue] = arg.split("=", 2);
    const value = inlineValue !== undefined ? inlineValue : argv[i + 1];
    const consumeNext = inlineValue === undefined;

    if (flag === "--input") {
      opts.input = path.resolve(rootDir, value || opts.input);
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = path.resolve(rootDir, value || opts.output);
      if (consumeNext) i += 1;
    } else if (flag === "--limit") {
      opts.limit = Number(value);
      if (consumeNext) i += 1;
    } else if (flag === "--offset") {
      opts.offset = Number(value);
      if (consumeNext) i += 1;
    } else if (flag === "--deadline-ms") {
      opts.deadlineMs = Number(value);
      if (consumeNext) i += 1;
    } else if (flag === "--unique-scrambles") {
      opts.uniqueScrambles = value !== "0" && String(value).toLowerCase() !== "false";
      if (consumeNext) i += 1;
    } else if (flag === "--sample-failures") {
      opts.sampleFailures = Number(value);
      if (consumeNext) i += 1;
    } else if (flag === "--sample-recoveries") {
      opts.sampleRecoveries = Number(value);
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/report-roux-recovery-cases.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>             Input details JSON");
  console.log("  --output <path>            Output report JSON");
  console.log("  --limit <n>                Number of records to evaluate (0 = all, default: 100)");
  console.log("  --offset <n>               Record offset before limiting");
  console.log("  --deadline-ms <n>          Per-scramble Roux deadline (default: 30000)");
  console.log("  --unique-scrambles <bool>  Deduplicate by scramble text (default: true)");
  console.log("  --sample-failures <n>      Failed examples to keep (default: 12)");
  console.log("  --sample-recoveries <n>    Recovered examples to keep (default: 12)");
}

function loadRecords(inputPath) {
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  throw new Error(`Unsupported report input shape: ${inputPath}`);
}

function toNonNegativeInt(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function increment(map, key) {
  const resolvedKey = String(key || "UNKNOWN").trim() || "UNKNOWN";
  map[resolvedKey] = (map[resolvedKey] || 0) + 1;
}

function pickSample(target, value, maxCount) {
  if (target.length < maxCount) target.push(value);
}

function trimStageDiagnostics(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((entry) => ({
    stage: entry?.stage || "",
    method: entry?.method || "",
    ok: entry?.ok === true,
    reason: entry?.reason || "",
    key: entry?.key || "",
    moveCount: Number.isFinite(entry?.moveCount) ? entry.moveCount : null,
    candidatesTried: Number.isFinite(entry?.candidatesTried) ? entry.candidatesTried : null,
    candidatesTotal: Number.isFinite(entry?.candidatesTotal) ? entry.candidatesTotal : null,
  }));
}

function trimStages(list) {
  if (!Array.isArray(list)) return [];
  return list.map((stage) => ({
    name: stage?.name || "",
    solution: stage?.solution || "",
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const allRecords = loadRecords(opts.input);
  const offset = toNonNegativeInt(opts.offset, 0);
  const limit = toNonNegativeInt(opts.limit, 100);
  const deadlineMs = Math.max(1000, toNonNegativeInt(opts.deadlineMs, 30000));
  const sampleFailures = Math.max(0, toNonNegativeInt(opts.sampleFailures, 12));
  const sampleRecoveries = Math.max(0, toNonNegativeInt(opts.sampleRecoveries, 12));

  const deduped = [];
  const seenScrambles = new Set();
  for (let i = 0; i < allRecords.length; i++) {
    const record = allRecords[i];
    const scramble = String(record?.scramble || "").trim();
    if (!scramble) continue;
    if (opts.uniqueScrambles) {
      if (seenScrambles.has(scramble)) continue;
      seenScrambles.add(scramble);
    }
    deduped.push(record);
  }

  const selected = deduped.slice(offset, limit > 0 ? offset + limit : undefined);
  const solved = await getDefaultPattern("333");

  const sourceCounts = {};
  const fallbackCounts = {};
  const failureReasonCounts = {};
  const failureStageCounts = {};
  const diagnosticReasonCounts = {};
  const diagnosticMethodCounts = {};
  const diagnosticStageReasonCounts = {};
  const durationsAll = [];
  const moveCountsAll = [];
  const moveCountsPure = [];
  const moveCountsRecovered = [];
  const failedExamples = [];
  const recoveryExamples = [];
  const pureExamples = [];

  let okCount = 0;
  let pureCount = 0;
  let recoveredCount = 0;
  let failedCount = 0;

  for (let i = 0; i < selected.length; i++) {
    const record = selected[i];
    const scramble = String(record?.scramble || "").trim();
    const pattern = solved.applyAlg(scramble);
    const startedAt = Date.now();
    let result;

    try {
      result = await solve3x3RouxFromPattern(pattern, {
        deadlineTs: Date.now() + deadlineMs,
        enableRecovery: true,
      });
    } catch (error) {
      result = {
        ok: false,
        reason: error?.message || "UNCAUGHT_ROUX_ERROR",
        stage: "FB",
        stageDiagnostics: [],
        stages: [],
        source: "REPORT_RUNTIME_EXCEPTION",
      };
    }

    const durationMs = Date.now() - startedAt;
    const source = String(result?.source || (result?.ok ? "INTERNAL_3X3_ROUX" : "UNKNOWN"));
    const fallbackFrom = String(result?.fallbackFrom || "");
    const moveCount = Number.isFinite(result?.moveCount) ? result.moveCount : null;
    const sample = {
      index: offset + i,
      id: record?.id ?? null,
      solver: record?.meta?.solver || "",
      method: record?.method || "",
      scramble,
      ok: result?.ok === true,
      source,
      fallbackFrom,
      reason: result?.reason || "",
      stage: result?.stage || "",
      moveCount,
      durationMs,
      stages: trimStages(result?.stages),
      stageDiagnostics: trimStageDiagnostics(result?.stageDiagnostics),
    };

    durationsAll.push(durationMs);
    if (moveCount != null) moveCountsAll.push(moveCount);
    increment(sourceCounts, source);

    if (Array.isArray(result?.stageDiagnostics)) {
      for (let d = 0; d < result.stageDiagnostics.length; d++) {
        const entry = result.stageDiagnostics[d];
        increment(diagnosticMethodCounts, entry?.method || "UNKNOWN");
        if (entry?.reason) {
          increment(diagnosticReasonCounts, entry.reason);
          increment(diagnosticStageReasonCounts, `${entry?.stage || "UNKNOWN"}:${entry.reason}`);
        }
      }
    }

    if (result?.ok) {
      okCount += 1;
      if (source === "INTERNAL_3X3_ROUX_PHASE_RECOVERY") {
        recoveredCount += 1;
        if (moveCount != null) moveCountsRecovered.push(moveCount);
        increment(fallbackCounts, fallbackFrom || "UNKNOWN");
        pickSample(recoveryExamples, sample, sampleRecoveries);
      } else {
        pureCount += 1;
        if (moveCount != null) moveCountsPure.push(moveCount);
        pickSample(pureExamples, sample, 6);
      }
    } else {
      failedCount += 1;
      increment(failureReasonCounts, result?.reason || "UNKNOWN");
      increment(failureStageCounts, result?.stage || "UNKNOWN");
      pickSample(failedExamples, sample, sampleFailures);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    input: opts.input,
    output: opts.output,
    parameters: {
      offset,
      limit,
      deadlineMs,
      uniqueScrambles: opts.uniqueScrambles,
      sampleFailures,
      sampleRecoveries,
    },
    dataset: {
      totalRecords: allRecords.length,
      uniqueScrambles: deduped.length,
      evaluated: selected.length,
    },
    caseDb: {
      schemaVersion: ROUX_CASE_DB?.schemaVersion || "",
      generatedAt: ROUX_CASE_DB?.generatedAt || "",
      fbPlans: Object.keys(ROUX_CASE_DB?.fbByPlan || {}),
      sbPlans: Object.keys(ROUX_CASE_DB?.sbByPlan || {}),
      cmllKeys: Object.keys(ROUX_CASE_DB?.cmll || {}).length,
      lseKeys: Object.keys(ROUX_CASE_DB?.lse || {}).length,
    },
    summary: {
      success: okCount,
      successRate: selected.length ? okCount / selected.length : 0,
      pureSuccess: pureCount,
      pureSuccessRate: selected.length ? pureCount / selected.length : 0,
      recoveredSuccess: recoveredCount,
      recoveredSuccessRate: selected.length ? recoveredCount / selected.length : 0,
      failed: failedCount,
      failedRate: selected.length ? failedCount / selected.length : 0,
      avgDurationMs: average(durationsAll),
      p50DurationMs: percentile(durationsAll, 0.5),
      p95DurationMs: percentile(durationsAll, 0.95),
      avgMoveCount: average(moveCountsAll),
      avgMoveCountPure: average(moveCountsPure),
      avgMoveCountRecovered: average(moveCountsRecovered),
    },
    counts: {
      sourceCounts,
      fallbackCounts,
      failureReasonCounts,
      failureStageCounts,
      diagnosticMethodCounts,
      diagnosticReasonCounts,
      diagnosticStageReasonCounts,
    },
    examples: {
      pure: pureExamples,
      recovered: recoveryExamples,
      failed: failedExamples,
    },
  };

  fs.writeFileSync(opts.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Wrote ${opts.output}`);
  console.log(
    `Evaluated ${selected.length}/${deduped.length} unique scrambles | pure=${pureCount} recovered=${recoveredCount} failed=${failedCount}`,
  );
  console.log(
    `Case DB keys: cmll=${report.caseDb.cmllKeys}, lse=${report.caseDb.lseKeys}, fbPlans=${report.caseDb.fbPlans.length}, sbPlans=${report.caseDb.sbPlans.length}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
