#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-index.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-player-summary.json");

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    minSolves: 10,
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
      opts.input = value || opts.input;
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    } else if (flag === "--min-solves") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) opts.minSolves = Math.max(1, n);
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/analyze-reco-3x3-index.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>      Input index JSON path");
  console.log("  --output <path>     Output summary JSON path");
  console.log("  --min-solves <n>    Minimum solves per player (default: 10)");
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function topEntry(mapObj) {
  const entries = Object.entries(mapObj || {});
  if (!entries.length) return { key: "", count: 0, ratio: 0 };
  entries.sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((acc, entry) => acc + entry[1], 0);
  return {
    key: entries[0][0],
    count: entries[0][1],
    ratio: total > 0 ? entries[0][1] / total : 0,
  };
}

function inferStyleTags(summary) {
  const tags = [];
  if (summary.primaryMethod === "ZB" && summary.primaryMethodRatio >= 0.7) {
    tags.push("zb-centric");
  }
  if (summary.primaryMethod === "CFOP" && summary.primaryMethodRatio >= 0.7) {
    tags.push("cfop-centric");
  }
  if (summary.avgMoveCount !== null && summary.avgMoveCount <= 46) {
    tags.push("low-move");
  }
  if (summary.avgTps !== null && summary.avgTps >= 11) {
    tags.push("high-tps");
  }
  if (
    summary.avgMoveCount !== null &&
    summary.avgMoveCount <= 48 &&
    summary.avgTps !== null &&
    summary.avgTps >= 10
  ) {
    tags.push("efficient");
  }
  return tags;
}

function normalizeMethodName(method) {
  const text = String(method || "").trim();
  if (!text) return "UNKNOWN";
  return text.toUpperCase();
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(opts.input)) {
    throw new Error(`Input not found: ${opts.input}`);
  }

  const parsed = JSON.parse(fs.readFileSync(opts.input, "utf8"));
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : [];
  const byPlayer = new Map();

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    const solver = String(row.solver || "").trim();
    if (!solver) continue;

    let agg = byPlayer.get(solver);
    if (!agg) {
      agg = {
        solver,
        solveCount: 0,
        resultSeconds: [],
        moveCounts: [],
        tpsValues: [],
        methods: {},
        reconstructors: {},
      };
      byPlayer.set(solver, agg);
    }

    agg.solveCount += 1;

    if (Number.isFinite(row.resultSeconds)) {
      agg.resultSeconds.push(row.resultSeconds);
    }
    if (Number.isFinite(row.moveCount)) {
      agg.moveCounts.push(row.moveCount);
    }
    if (Number.isFinite(row.tps)) {
      agg.tpsValues.push(row.tps);
    }

    const method = normalizeMethodName(row.method);
    agg.methods[method] = (agg.methods[method] || 0) + 1;

    const reconstructor = String(row.reconstructedBy || "").trim() || "UNKNOWN";
    agg.reconstructors[reconstructor] = (agg.reconstructors[reconstructor] || 0) + 1;
  }

  const summaries = [];
  for (const agg of byPlayer.values()) {
    if (agg.solveCount < opts.minSolves) continue;
    const methodTop = topEntry(agg.methods);
    const reconstructorTop = topEntry(agg.reconstructors);

    const summary = {
      solver: agg.solver,
      solveCount: agg.solveCount,
      avgResultSeconds: average(agg.resultSeconds),
      medianResultSeconds: median(agg.resultSeconds),
      avgMoveCount: average(agg.moveCounts),
      medianMoveCount: median(agg.moveCounts),
      avgTps: average(agg.tpsValues),
      medianTps: median(agg.tpsValues),
      primaryMethod: methodTop.key,
      primaryMethodRatio: methodTop.ratio,
      primaryReconstructor: reconstructorTop.key,
      methodBreakdown: agg.methods,
      reconstructorBreakdown: agg.reconstructors,
      styleTags: [],
    };

    summary.styleTags = inferStyleTags(summary);
    summaries.push(summary);
  }

  summaries.sort((a, b) => b.solveCount - a.solveCount || a.solver.localeCompare(b.solver));

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceInput: opts.input,
    minSolves: opts.minSolves,
    playerCount: summaries.length,
    players: summaries,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (${summaries.length} players)`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
