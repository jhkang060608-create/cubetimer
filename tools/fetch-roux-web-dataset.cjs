#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "solver", "rouxDataset.js");
const SCHEMA_VERSION = "roux-web.v1";

const SOURCES = Object.freeze({
  CMLL: [
    "https://www.speedcubedb.com/a/3x3/CMLL",
  ],
  LSE: [
    "https://www.speedcubedb.com/a/3x3/EO4A",
    "https://www.speedcubedb.com/a/3x3/ELL",
  ],
  // Roux First Block (1x2x3) builders
  FB: [
    "https://www.speedcubedb.com/a/3x3/RouxFB",
  ],
  // Roux Second Block (1x2x3) builders
  SB: [
    "https://www.speedcubedb.com/a/3x3/RouxSB",
  ],
});

function parseArgs(argv) {
  const opts = {
    output: DEFAULT_OUTPUT,
    timeoutMs: 30000,
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
    if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    } else if (flag === "--timeout-ms") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 1000) {
        opts.timeoutMs = Math.floor(n);
      }
      if (consumeNext) i += 1;
    }
  }
  return opts;
}

function printHelp() {
  console.log("Usage: node tools/fetch-roux-web-dataset.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --output <path>       Output dataset module path");
  console.log("  --timeout-ms <n>      Per-request timeout in ms (default: 30000)");
}

function decodeHtmlEntities(input) {
  return String(input || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function sanitizeVariant(raw) {
  let text = decodeHtmlEntities(raw)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  // Drop setup/comment wrappers and commutator-only punctuation.
  text = text
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[,:;]/g, " ")
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const forbidden = ["http://", "https://", "alg.cubing.net", "youtube.com", "youtu.be"];
  const lower = text.toLowerCase();
  for (let i = 0; i < forbidden.length; i++) {
    if (lower.includes(forbidden[i])) return "";
  }

  const tokens = text.split(" ").filter(Boolean);
  if (!tokens.length) return "";
  const tokenRe = /^[URFDLBMESXYZurfdlbmesxyz](?:w)?(?:2|')?$/;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokenRe.test(tokens[i])) return "";
  }
  return tokens.join(" ");
}

function splitVariants(rawAlg) {
  const variants = String(rawAlg || "").split("/");
  const out = [];
  const seen = new Set();
  for (let i = 0; i < variants.length; i++) {
    const normalized = sanitizeVariant(variants[i]);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function extractAlgorithmsFromHtml(html) {
  const out = [];
  const seen = new Set();

  // Primary: solved algorithm payload used by twsity preview.
  const dataAlgRe = /class="[^"]*cubedb-ftw-[^"]*"[^>]*\bdata-alg="([^"]+)"/gi;
  let match;
  while ((match = dataAlgRe.exec(html)) !== null) {
    const variants = splitVariants(match[1]);
    for (let i = 0; i < variants.length; i++) {
      const value = variants[i];
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }

  // Fallback: visible formatted algorithm text.
  const formattedRe = /class="formatted-alg">([\s\S]*?)<\/div>/gi;
  while ((match = formattedRe.exec(html)) !== null) {
    const variants = splitVariants(match[1]);
    for (let i = 0; i < variants.length; i++) {
      const value = variants[i];
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }

  return out;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "CubeTimer-RouxDatasetFetcher/1.0",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function dedupePreserveOrder(list) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const value = list[i];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function buildOutput({ cmll, lse, fb, sb, sourceMeta, generatedAt }) {
  const lines = [];
  lines.push("// Auto-generated by tools/fetch-roux-web-dataset.cjs");
  lines.push(`// Generated at: ${generatedAt}`);
  lines.push("");
  lines.push("export const ROUX_FORMULAS = Object.freeze({");
  lines.push(`  CMLL: ${JSON.stringify(cmll, null, 2)},`);
  lines.push(`  LSE: ${JSON.stringify(lse, null, 2)},`);
  lines.push(`  FB: ${JSON.stringify(fb || [], null, 2)},`);
  lines.push(`  SB: ${JSON.stringify(sb || [], null, 2)},`);
  lines.push("});");
  lines.push("");
  lines.push("export const ROUX_FORMULA_COUNTS = Object.freeze({");
  lines.push(`  CMLL: ${cmll.length},`);
  lines.push(`  LSE: ${lse.length},`);
  lines.push(`  FB: ${(fb || []).length},`);
  lines.push(`  SB: ${(sb || []).length},`);
  lines.push("});");
  lines.push("");
  lines.push("export const ROUX_DATASET_META = Object.freeze(");
  lines.push(
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        generatedAt,
        sourceMeta,
      },
      null,
      2,
    ),
  );
  lines.push(");");
  lines.push("");
  return lines.join("\n");
}

async function collectCategory(category, urls, timeoutMs) {
  const formulas = [];
  const sourceMeta = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const html = await fetchText(url, timeoutMs);
    const extracted = extractAlgorithmsFromHtml(html);
    const deduped = dedupePreserveOrder(extracted);
    for (let j = 0; j < deduped.length; j++) {
      formulas.push(deduped[j]);
    }
    sourceMeta.push({
      category,
      url,
      extractedCount: deduped.length,
    });
  }
  return {
    formulas: dedupePreserveOrder(formulas),
    sourceMeta,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const generatedAt = new Date().toISOString();
  const cmllResult = await collectCategory("CMLL", SOURCES.CMLL, opts.timeoutMs);
  const lseResult = await collectCategory("LSE", SOURCES.LSE, opts.timeoutMs);
  
  // Try FB/SB but don't fail if not available
  let fbResult = { formulas: [], sourceMeta: [] };
  let sbResult = { formulas: [], sourceMeta: [] };
  try {
    fbResult = await collectCategory("FB", SOURCES.FB, opts.timeoutMs);
  } catch (e) {
    console.warn(`Warning: Could not fetch FB algorithms: ${e.message}`);
  }
  try {
    sbResult = await collectCategory("SB", SOURCES.SB, opts.timeoutMs);
  } catch (e) {
    console.warn(`Warning: Could not fetch SB algorithms: ${e.message}`);
  }

  if (!cmllResult.formulas.length) {
    throw new Error("No CMLL formulas extracted from web sources.");
  }
  if (!lseResult.formulas.length) {
    throw new Error("No LSE formulas extracted from web sources.");
  }

  const outputCode = buildOutput({
    cmll: cmllResult.formulas,
    lse: lseResult.formulas,
    fb: fbResult.formulas,
    sb: sbResult.formulas,
    sourceMeta: cmllResult.sourceMeta.concat(lseResult.sourceMeta, fbResult.sourceMeta, sbResult.sourceMeta),
    generatedAt,
  });
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${outputCode}\n`, "utf8");

  console.log(`Wrote ${opts.output}`);
  console.log(`CMLL formulas: ${cmllResult.formulas.length}`);
  console.log(`LSE formulas: ${lseResult.formulas.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
