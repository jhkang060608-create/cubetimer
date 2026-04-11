#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseCsvList(value, fallback) {
  const parsed = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed.length ? parsed : fallback.slice();
}

function parseArgs(argv) {
  const opts = {
    inputs: [],
    output: "",
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
      opts.inputs = [value || ""];
      if (consumeNext) i += 1;
    } else if (flag === "--inputs") {
      opts.inputs = parseCsvList(value, opts.inputs);
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    }
  }

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/merge-reco-style-benchmark.cjs --inputs <csv> --output <path>");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>       Single benchmark JSON input");
  console.log("  --inputs <csv>       Multiple benchmark JSON inputs");
  console.log("  --output <path>      Merged benchmark JSON output");
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function mergeKeyedObject(inputs, key) {
  const out = {};
  for (let i = 0; i < inputs.length; i++) {
    const payload = inputs[i];
    const obj = payload && typeof payload[key] === "object" ? payload[key] : null;
    if (!obj) continue;
    for (const [mode, value] of Object.entries(obj)) {
      out[mode] = value;
    }
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.inputs.length) {
    throw new Error("No inputs provided.");
  }
  if (!opts.output) {
    throw new Error("No output provided.");
  }

  const payloads = opts.inputs.map(loadJson);
  const base = payloads[0];
  const mergedModes = new Set();
  for (const payload of payloads) {
    const modes = Array.isArray(payload?.parameters?.modes) ? payload.parameters.modes : [];
    for (const mode of modes) mergedModes.add(mode);
  }

  const merged = {
    generatedAt: new Date().toISOString(),
    sourceInput: base.sourceInput || null,
    sourceStyleProfileInput: base.sourceStyleProfileInput || null,
    parameters: {
      ...(base.parameters || {}),
      modes: Array.from(mergedModes),
    },
    sampleCount: base.sampleCount || 0,
    distanceConfig: base.distanceConfig || null,
    gateThresholds: base.gateThresholds || null,
    summariesByMode: mergeKeyedObject(payloads, "summariesByMode"),
    comparisonVsLegacyByMode: mergeKeyedObject(payloads, "comparisonVsLegacyByMode"),
    gateEvaluationByMode: mergeKeyedObject(payloads, "gateEvaluationByMode"),
    runsByMode: mergeKeyedObject(payloads, "runsByMode"),
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output}`);
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
