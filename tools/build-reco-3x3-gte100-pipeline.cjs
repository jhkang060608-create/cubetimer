#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_RECO_DIR = path.join(ROOT_DIR, "vendor-data", "reco");

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseCsvList(value, fallback) {
  const list = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return list.length ? list : fallback.slice();
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === "1" || text === "true" || text === "yes") return true;
  if (text === "0" || text === "false" || text === "no") return false;
  return fallback;
}

function parseArgs(argv) {
  const opts = {
    indexInput: path.join(DEFAULT_RECO_DIR, "reco-all-3x3-index.json"),
    detailsInput: path.join(DEFAULT_RECO_DIR, "reco-all-3x3-details.json"),
    outputDir: DEFAULT_RECO_DIR,
    minSolves: 100,
    methods: ["CFOP", "ZB"],
    benchmarkPerSolverLimit: 12,
    benchmarkScrambleConcurrency: 2,
    strictTimeoutMs: 3000,
    zbTimeoutMs: 5000,
    benchmarkStyles: ["legacy", "balanced", "rotationless", "low-auf"],
    skipBenchmark: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    const [flag, inline] = arg.split("=", 2);
    const value = inline !== undefined ? inline : argv[i + 1];
    const consumeNext = inline === undefined;

    if (flag === "--index-input") {
      opts.indexInput = value || opts.indexInput;
      if (consumeNext) i += 1;
    } else if (flag === "--details-input") {
      opts.detailsInput = value || opts.detailsInput;
      if (consumeNext) i += 1;
    } else if (flag === "--output-dir") {
      opts.outputDir = value || opts.outputDir;
      if (consumeNext) i += 1;
    } else if (flag === "--min-solves") {
      opts.minSolves = Math.max(1, parseIntOrFallback(value, opts.minSolves));
      if (consumeNext) i += 1;
    } else if (flag === "--methods") {
      opts.methods = parseCsvList(value, opts.methods).map((method) => method.toUpperCase());
      if (consumeNext) i += 1;
    } else if (flag === "--benchmark-per-solver-limit") {
      opts.benchmarkPerSolverLimit = Math.max(
        1,
        parseIntOrFallback(value, opts.benchmarkPerSolverLimit),
      );
      if (consumeNext) i += 1;
    } else if (flag === "--benchmark-scramble-concurrency") {
      opts.benchmarkScrambleConcurrency = Math.max(
        1,
        parseIntOrFallback(value, opts.benchmarkScrambleConcurrency),
      );
      if (consumeNext) i += 1;
    } else if (flag === "--strict-timeout-ms") {
      opts.strictTimeoutMs = Math.max(1000, parseIntOrFallback(value, opts.strictTimeoutMs));
      if (consumeNext) i += 1;
    } else if (flag === "--zb-timeout-ms") {
      opts.zbTimeoutMs = Math.max(1000, parseIntOrFallback(value, opts.zbTimeoutMs));
      if (consumeNext) i += 1;
    } else if (flag === "--benchmark-styles") {
      opts.benchmarkStyles = parseCsvList(value, opts.benchmarkStyles);
      if (consumeNext) i += 1;
    } else if (flag === "--skip-benchmark") {
      opts.skipBenchmark = parseBool(value, opts.skipBenchmark);
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/build-reco-3x3-gte100-pipeline.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --index-input <path>                   Input all-index JSON");
  console.log("  --details-input <path>                 Input all-details JSON");
  console.log("  --output-dir <path>                    Output directory (default: vendor-data/reco)");
  console.log("  --min-solves <n>                       Minimum solves per player (default: 100)");
  console.log("  --methods <csv>                        Allowed primary methods (default: CFOP,ZB)");
  console.log("  --benchmark-per-solver-limit <n>       Balanced benchmark samples per solver (default: 12)");
  console.log("  --benchmark-scramble-concurrency <n>   Benchmark scramble concurrency (default: 2)");
  console.log("  --strict-timeout-ms <n>                Strict mode timeout (default: 3000)");
  console.log("  --zb-timeout-ms <n>                    ZB mode timeout (default: 5000)");
  console.log("  --benchmark-styles <csv>               Styles to benchmark");
  console.log("  --skip-benchmark <bool>                Skip benchmark+learn steps (default: false)");
}

function loadRecordsOrThrow(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.records) ? parsed.records : null;
  if (!records) {
    throw new Error(`Input has no records array: ${inputPath}`);
  }
  return { parsed, records };
}

function normalizeMethod(value) {
  return String(value || "").trim().toUpperCase();
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    cwd: ROOT_DIR,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: node ${path.relative(ROOT_DIR, scriptPath)} ${args.join(" ")}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const methodSet = new Set(opts.methods);
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const indexDoc = loadRecordsOrThrow(opts.indexInput);
  const detailsDoc = loadRecordsOrThrow(opts.detailsInput);

  const methodCountsBySolver = new Map();
  for (let i = 0; i < indexDoc.records.length; i++) {
    const row = indexDoc.records[i];
    const puzzle = String(row?.puzzle || "").trim();
    if (puzzle && puzzle !== "3x3") continue;
    const solver = String(row?.solver || "").trim();
    if (!solver) continue;
    const method = normalizeMethod(row?.method);
    const byMethod = methodCountsBySolver.get(solver) || {};
    byMethod[method] = (byMethod[method] || 0) + 1;
    methodCountsBySolver.set(solver, byMethod);
  }

  const eligiblePlayers = [];
  for (const [solver, byMethod] of methodCountsBySolver.entries()) {
    const totalSolves = Object.values(byMethod).reduce((acc, count) => acc + Number(count || 0), 0);
    if (totalSolves < opts.minSolves) continue;
    const sortedMethods = Object.entries(byMethod).sort((a, b) => b[1] - a[1]);
    const primaryMethod = String(sortedMethods[0]?.[0] || "UNKNOWN").toUpperCase();
    if (!methodSet.has(primaryMethod)) continue;
    const primaryMethodRatio = totalSolves > 0 ? Number((Number(sortedMethods[0][1]) / totalSolves).toFixed(6)) : 0;
    eligiblePlayers.push({
      solver,
      totalSolves,
      primaryMethod,
      primaryMethodRatio,
      methodCounts: byMethod,
    });
  }
  eligiblePlayers.sort((a, b) => b.totalSolves - a.totalSolves || a.solver.localeCompare(b.solver));
  const eligibleSolverSet = new Set(eligiblePlayers.map((row) => row.solver));

  const filteredIndexRecords = indexDoc.records.filter((row) => {
    const puzzle = String(row?.puzzle || "").trim();
    if (puzzle && puzzle !== "3x3") return false;
    const solver = String(row?.solver || "").trim();
    if (!eligibleSolverSet.has(solver)) return false;
    const method = normalizeMethod(row?.method);
    return methodSet.has(method);
  });

  const filteredDetailRecords = detailsDoc.records.filter((row) => {
    if (!row || row.ok === false) return false;
    const puzzle = String(row?.meta?.puzzle || row?.puzzle || "").trim();
    if (puzzle && puzzle !== "3x3") return false;
    const solver = String(row?.meta?.solver || row?.solver || "").trim();
    if (!eligibleSolverSet.has(solver)) return false;
    const method = normalizeMethod(row?.method || row?.meta?.method);
    return methodSet.has(method);
  });

  const gte100IndexPath = path.join(opts.outputDir, "reco-all-3x3-gte100-index.json");
  const gte100DetailsPath = path.join(opts.outputDir, "reco-all-3x3-gte100-details.json");
  const styleProfilesPath = path.join(opts.outputDir, "reco-3x3-style-profiles.json");
  const styleDetailsPath = path.join(opts.outputDir, "reco-3x3-style-details.json");
  const styleFeaturesPath = path.join(opts.outputDir, "reco-3x3-style-features.json");
  const benchmarkStrictPath = path.join(opts.outputDir, "reco-3x3-style-benchmark-strict.json");
  const benchmarkZbPath = path.join(opts.outputDir, "reco-3x3-style-benchmark-zb.json");
  const benchmarkMergedPath = path.join(opts.outputDir, "reco-3x3-style-benchmark.json");
  const learnedStylePath = path.join(opts.outputDir, "reco-3x3-learned-style-weights.json");
  const mixedProfilePath = path.join(opts.outputDir, "reco-3x3-mixed-cfop-profile.json");

  const indexPayload = {
    generatedAt: new Date().toISOString(),
    sourceInput: opts.indexInput,
    pipeline: "reco-gte100-cfop-zb",
    minSolves: opts.minSolves,
    methods: opts.methods,
    playerCount: eligiblePlayers.length,
    players: eligiblePlayers,
    recordCount: filteredIndexRecords.length,
    records: filteredIndexRecords,
  };
  fs.writeFileSync(gte100IndexPath, `${JSON.stringify(indexPayload, null, 2)}\n`, "utf8");

  const detailsPayload = {
    generatedAt: new Date().toISOString(),
    sourceInput: opts.detailsInput,
    pipeline: "reco-gte100-cfop-zb",
    minSolves: opts.minSolves,
    methods: opts.methods,
    playerCount: eligiblePlayers.length,
    players: eligiblePlayers,
    recordCount: filteredDetailRecords.length,
    records: filteredDetailRecords,
  };
  fs.writeFileSync(gte100DetailsPath, `${JSON.stringify(detailsPayload, null, 2)}\n`, "utf8");
  console.log(`Wrote filtered index: ${gte100IndexPath} (${filteredIndexRecords.length} records)`);
  console.log(`Wrote filtered details: ${gte100DetailsPath} (${filteredDetailRecords.length} records)`);

  runNodeScript(path.join(ROOT_DIR, "tools", "analyze-reco-3x3-details.cjs"), [
    "--input",
    gte100DetailsPath,
    "--output",
    styleProfilesPath,
    "--puzzle",
    "3x3",
    "--min-solves",
    String(opts.minSolves),
  ]);

  runNodeScript(path.join(ROOT_DIR, "tools", "build-reco-3x3-top10-style-details.cjs"), [
    "--input",
    styleProfilesPath,
    "--output",
    styleDetailsPath,
    "--min-solves",
    String(opts.minSolves),
  ]);

  runNodeScript(path.join(ROOT_DIR, "tools", "build-reco-3x3-style-features.cjs"), [
    "--input",
    gte100DetailsPath,
    "--output",
    styleFeaturesPath,
    "--min-solves",
    String(opts.minSolves),
    "--verify-sample",
    "0",
    "--verify-all",
    "false",
  ]);

  if (!opts.skipBenchmark) {
    const commonBenchmarkArgs = [
      "--input",
      gte100DetailsPath,
      "--style-profile-input",
      styleFeaturesPath,
      "--per-solver-limit",
      String(opts.benchmarkPerSolverLimit),
      "--scramble-concurrency",
      String(opts.benchmarkScrambleConcurrency),
      "--styles",
      opts.benchmarkStyles.join(","),
      "--methods",
      opts.methods.join(","),
    ];
    runNodeScript(path.join(ROOT_DIR, "tools", "benchmark-f2l-style-ab.mjs"), [
      ...commonBenchmarkArgs,
      "--mode",
      "strict",
      "--strict-timeout-ms",
      String(opts.strictTimeoutMs),
      "--output",
      benchmarkStrictPath,
    ]);

    runNodeScript(path.join(ROOT_DIR, "tools", "benchmark-f2l-style-ab.mjs"), [
      ...commonBenchmarkArgs,
      "--mode",
      "zb",
      "--zb-timeout-ms",
      String(opts.zbTimeoutMs),
      "--output",
      benchmarkZbPath,
    ]);

    runNodeScript(path.join(ROOT_DIR, "tools", "merge-reco-style-benchmark.cjs"), [
      "--inputs",
      `${benchmarkStrictPath},${benchmarkZbPath}`,
      "--output",
      benchmarkMergedPath,
    ]);

    runNodeScript(path.join(ROOT_DIR, "tools", "learn-reco-player-style-weights.cjs"), [
      "--benchmarks",
      benchmarkMergedPath,
      "--players",
      styleDetailsPath,
      "--modes",
      "strict,zb",
      "--min-samples",
      String(Math.max(4, Math.floor(opts.benchmarkPerSolverLimit / 2))),
      "--objective",
      "aggressive",
      "--output",
      learnedStylePath,
    ]);
  }

  runNodeScript(path.join(ROOT_DIR, "tools", "build-reco-3x3-top10-mixed-cfop-profile.cjs"), [
    "--details",
    gte100DetailsPath,
    "--style-details",
    styleDetailsPath,
    "--methods",
    opts.methods.join(","),
    "--min-solves",
    String(opts.minSolves),
    "--output",
    mixedProfilePath,
  ]);

  console.log("Pipeline complete.");
  console.log(`style details: ${styleDetailsPath}`);
  console.log(`mixed profile: ${mixedProfilePath}`);
  if (!opts.skipBenchmark) {
    console.log(`benchmark merged: ${benchmarkMergedPath}`);
    console.log(`learned styles: ${learnedStylePath}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
