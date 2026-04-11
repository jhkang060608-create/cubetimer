#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_INPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-index.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-details.json");
const SCHEMA_VERSION = "reco-details.v1";
const DATA_CONTRACT = Object.freeze({
  requiredFields: ["solver", "method", "result", "scramble", "algorithmPlain"],
  optionalFields: ["steps", "tags", "stats", "inspection", "meta.reconstructor"],
});

function normalizePuzzleFilter(value) {
  const text = String(value || "3x3").trim();
  if (!text) return "3x3";
  if (text.toLowerCase() === "all") return "all";
  return text;
}

function parseIntOrFallback(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function parseArgs(argv) {
  const opts = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    offset: 0,
    limit: 0,
    puzzle: "3x3",
    concurrency: 4,
    delayMs: 250,
    retries: 2,
    requestTimeoutMs: 15000,
    checkpointEvery: 25,
    resume: true,
    userAgent: "CubeTimerRecoBot/0.1 (+local-analysis)",
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
    } else if (flag === "--offset") {
      opts.offset = Math.max(0, parseIntOrFallback(value, opts.offset));
      if (consumeNext) i += 1;
    } else if (flag === "--limit") {
      opts.limit = Math.max(0, parseIntOrFallback(value, opts.limit));
      if (consumeNext) i += 1;
    } else if (flag === "--puzzle") {
      opts.puzzle = normalizePuzzleFilter(value);
      if (consumeNext) i += 1;
    } else if (flag === "--concurrency") {
      opts.concurrency = Math.max(1, parseIntOrFallback(value, opts.concurrency));
      if (consumeNext) i += 1;
    } else if (flag === "--delay-ms") {
      opts.delayMs = Math.max(0, parseIntOrFallback(value, opts.delayMs));
      if (consumeNext) i += 1;
    } else if (flag === "--retries") {
      opts.retries = Math.max(0, parseIntOrFallback(value, opts.retries));
      if (consumeNext) i += 1;
    } else if (flag === "--request-timeout-ms") {
      opts.requestTimeoutMs = Math.max(1000, parseIntOrFallback(value, opts.requestTimeoutMs));
      if (consumeNext) i += 1;
    } else if (flag === "--checkpoint-every") {
      opts.checkpointEvery = Math.max(1, parseIntOrFallback(value, opts.checkpointEvery));
      if (consumeNext) i += 1;
    } else if (flag === "--resume") {
      const normalized = String(value || "true").toLowerCase();
      opts.resume = normalized !== "0" && normalized !== "false" && normalized !== "no";
      if (consumeNext) i += 1;
    } else if (flag === "--user-agent") {
      opts.userAgent = value || opts.userAgent;
      if (consumeNext) i += 1;
    }
  }

  opts.puzzle = normalizePuzzleFilter(opts.puzzle);
  opts.concurrency = Math.max(1, opts.concurrency);

  return opts;
}

function printHelp() {
  console.log("Usage: node tools/fetch-reco-3x3-details.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --input <path>             Input index JSON (default: vendor-data/reco/reco-3x3-index.json)");
  console.log("  --output <path>            Output details JSON");
  console.log("  --offset <n>               Record offset in input list (default: 0)");
  console.log("  --limit <n>                Max records to fetch (default: 0=all)");
  console.log("  --puzzle <name|all>        Puzzle filter from index records (default: 3x3)");
  console.log("  --concurrency <n>          Parallel fetch workers (default: 4)");
  console.log("  --delay-ms <n>             Delay between requests (default: 250)");
  console.log("  --retries <n>              Retry attempts per record (default: 2)");
  console.log("  --request-timeout-ms <n>   Timeout per HTTP request (default: 15000)");
  console.log("  --checkpoint-every <n>     Save every N fetched records (default: 25)");
  console.log("  --resume <true|false>      Reuse existing successful entries (default: true)");
  console.log("  --user-agent <text>        User-Agent header");
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number.parseInt(code, 10);
      return Number.isFinite(n) ? String.fromCharCode(n) : "";
    });
}

function stripTags(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function normalizeAlgorithmText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitMoveTokens(text) {
  return String(text || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseAlgorithmSteps(annotated) {
  const lines = normalizeAlgorithmText(annotated)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const steps = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const commentIndex = line.indexOf("//");
    const moves = commentIndex >= 0 ? line.slice(0, commentIndex).trim() : line;
    const label = commentIndex >= 0 ? line.slice(commentIndex + 2).trim() : "";
    const moveCount = splitMoveTokens(moves).length;
    steps.push({
      order: i + 1,
      label,
      moves,
      moveCount,
    });
  }

  return steps;
}

function buildPlainAlgorithm(steps) {
  const parts = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].moves) parts.push(steps[i].moves);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function parseStatCellValue(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return null;
  if (/^n\/a$/i.test(normalized)) return null;
  const numeric = Number.parseFloat(normalized.replace(/%/g, ""));
  if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?%?$/.test(normalized)) {
    return numeric;
  }
  return normalized;
}

function parseStatsTable(html) {
  const tableMatch = html.match(/<table[^>]*id=['"]solvestats['"][^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) {
    return {
      columns: [],
      rows: {},
    };
  }

  const tableHtml = tableMatch[1];
  const rowMatches = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rowMatches.length) {
    return {
      columns: [],
      rows: {},
    };
  }

  function parseRowCells(rowHtml) {
    return [...rowHtml.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((m) => stripTags(m[1]));
  }

  const headerCells = parseRowCells(rowMatches[0][1]).filter((v, idx) => !(idx === 0 && !v));

  const rows = {};
  for (let i = 1; i < rowMatches.length; i++) {
    const rowHtml = rowMatches[i][1];
    const cells = parseRowCells(rowHtml);
    if (!cells.length) continue;
    const rowName = cells[0] || `row_${i}`;
    const values = {};
    for (let c = 1; c < cells.length; c++) {
      const colName = headerCells[c - 1] || `col_${c}`;
      values[colName] = parseStatCellValue(cells[c]);
    }
    rows[rowName] = values;
  }

  return {
    columns: headerCells,
    rows,
  };
}

function parseSolveMeta(html) {
  const h1Match = html.match(
    /<h1>\s*<a[^>]*id=['"]solver-link['"][^>]*>([^<]+)<\/a>\s*-\s*([0-9.]+)\s+([^<]+?)\s+solve\s*<\/h1>/i,
  );
  const h3Match = html.match(
    /<h3>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*-\s*([\s\S]*?)\s*-\s*reconstruction by\s*<a[^>]*id=['"]reconstructor-link['"][^>]*>([^<]+)<\/a>\s*<\/h3>/i,
  );

  return {
    solver: h1Match ? decodeHtmlEntities(h1Match[1]).trim() : "",
    result: h1Match ? decodeHtmlEntities(h1Match[2]).trim() : "",
    puzzle: h1Match ? decodeHtmlEntities(h1Match[3]).trim() : "",
    date: h3Match ? decodeHtmlEntities(h3Match[1]).trim() : "",
    competition: h3Match ? decodeHtmlEntities(h3Match[2]).replace(/\s+/g, " ").trim() : "",
    reconstructor: h3Match ? decodeHtmlEntities(h3Match[3]).trim() : "",
  };
}

function parseAlgCubingLink(html) {
  const linkMatch = html.match(/href=["'](https:\/\/alg\.cubing\.net\/\?[^"']+)["'][^>]*>\s*alg\.cubing\.net/i);
  if (!linkMatch) return null;

  const urlText = decodeHtmlEntities(linkMatch[1]);
  try {
    const url = new URL(urlText);
    const setup = normalizeAlgorithmText(url.searchParams.get("setup") || "");
    const alg = normalizeAlgorithmText(url.searchParams.get("alg") || "");
    return {
      url: url.toString(),
      setup,
      alg,
    };
  } catch (_) {
    return null;
  }
}

function parseReconstructionBlock(html) {
  const blockMatch = html.match(/<div[^>]*id=['"]reconstruction['"][^>]*>([\s\S]*?)<\/div>/i);
  if (!blockMatch) return "";
  return normalizeAlgorithmText(stripTags(blockMatch[1]));
}

function extractInspectionMoves(steps) {
  for (let i = 0; i < steps.length; i++) {
    if (/inspection/i.test(steps[i].label)) {
      return steps[i].moves || "";
    }
  }
  return "";
}

function parseSolveDetails(html, sourceRecord) {
  const meta = parseSolveMeta(html);
  const algLink = parseAlgCubingLink(html);
  const reconstructionText = parseReconstructionBlock(html);

  let scramble = "";
  let algorithmAnnotated = "";

  if (algLink) {
    scramble = algLink.setup;
    algorithmAnnotated = algLink.alg;
  } else {
    algorithmAnnotated = reconstructionText;
  }

  const steps = parseAlgorithmSteps(algorithmAnnotated);
  const inspection = extractInspectionMoves(steps);
  const algorithmPlain = buildPlainAlgorithm(steps);
  const stats = parseStatsTable(html);

  return {
    id: sourceRecord.id,
    solveUrl: sourceRecord.solveUrl || `https://reco.nz/solve/${sourceRecord.id}`,
    sourcePage: sourceRecord.sourcePage ?? null,
    method: sourceRecord.method || "",
    tags: sourceRecord.tags || "",
    meta,
    scramble,
    inspection,
    algorithmAnnotated,
    algorithmPlain,
    steps,
    stats,
  };
}

function fetchTextViaHttps(url, headers, timeoutMs, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        resolve(fetchTextViaHttps(nextUrl, headers, timeoutMs, redirectCount + 1));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`));
    });
    req.on("error", reject);
  });
}

async function fetchText(url, headers, timeoutMs) {
  if (typeof fetch === "function") {
    let timer = null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    try {
      if (controller) {
        timer = setTimeout(() => controller.abort(), timeoutMs);
      }
      const response = await fetch(url, {
        headers,
        signal: controller ? controller.signal : undefined,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response.text();
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        throw new Error(`REQUEST_TIMEOUT_${timeoutMs}MS`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return fetchTextViaHttps(url, headers, timeoutMs);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function loadIndexRecords(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.records)) return parsed.records;
  throw new Error(`Input has no records array: ${inputPath}`);
}

function loadExistingOutput(outputPath) {
  if (!fs.existsSync(outputPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.records)) return parsed.records;
  } catch (_) {}
  return [];
}

function writeOutput(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function fetchWithRetries(url, headers, retries, timeoutMs) {
  let lastError = null;
  const attempts = Math.max(1, retries + 1);
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchText(url, headers, timeoutMs);
    } catch (error) {
      lastError = error;
      if (i + 1 < attempts) {
        await sleep(250 * (i + 1));
      }
    }
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

function summarizeQuality(records) {
  let okRecords = 0;
  let requiredMissing = 0;
  let missingScramble = 0;
  let missingSolution = 0;
  let missingSteps = 0;
  let missingStats = 0;

  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row || !row.ok) continue;
    okRecords += 1;
    const solver = String(row?.meta?.solver || row?.solver || "").trim();
    const method = String(row.method || row?.meta?.method || "").trim();
    const result = String(row?.meta?.result || row?.result || "").trim();
    const scramble = String(row.scramble || "").trim();
    const solution = String(row.algorithmPlain || "").trim();
    if (!solver || !method || !result || !scramble || !solution) {
      requiredMissing += 1;
    }
    if (!scramble) missingScramble += 1;
    if (!solution) missingSolution += 1;
    if (!Array.isArray(row.steps) || row.steps.length === 0) missingSteps += 1;
    if (!row.stats || !row.stats.rows || Object.keys(row.stats.rows).length === 0) missingStats += 1;
  }

  return {
    okRecords,
    requiredMissing,
    requiredMissingRate: okRecords > 0 ? requiredMissing / okRecords : 0,
    missingScramble,
    missingScrambleRate: okRecords > 0 ? missingScramble / okRecords : 0,
    missingSolution,
    missingSolutionRate: okRecords > 0 ? missingSolution / okRecords : 0,
    missingSteps,
    missingStepsRate: okRecords > 0 ? missingSteps / okRecords : 0,
    missingStats,
    missingStatsRate: okRecords > 0 ? missingStats / okRecords : 0,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const allRecords = loadIndexRecords(opts.input)
    .filter((row) => opts.puzzle === "all" || String(row.puzzle || "") === opts.puzzle)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

  const selected = opts.limit > 0
    ? allRecords.slice(opts.offset, opts.offset + opts.limit)
    : allRecords.slice(opts.offset);

  const existing = opts.resume ? loadExistingOutput(opts.output) : [];
  const existingById = new Map();
  for (let i = 0; i < existing.length; i++) {
    const item = existing[i];
    if (item && Number.isFinite(Number(item.id))) {
      existingById.set(Number(item.id), item);
    }
  }

  const headers = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
  };

  const outputById = new Map();
  const pending = [];
  let fetchedCount = 0;
  let skippedCount = 0;
  let okCount = 0;
  let failedCount = 0;

  for (let i = 0; i < selected.length; i++) {
    const source = selected[i];
    const id = Number(source.id);
    const existingEntry = existingById.get(id);

    if (existingEntry && existingEntry.ok) {
      outputById.set(id, existingEntry);
      skippedCount += 1;
      continue;
    }

    pending.push(source);
  }

  function buildPayload() {
    const records = Array.from(outputById.values()).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    return {
      generatedAt: new Date().toISOString(),
      sourceInput: opts.input,
      source: "https://reco.nz/",
      schemaVersion: SCHEMA_VERSION,
      dataContract: DATA_CONTRACT,
      crawlPolicy: {
        userAgent: opts.userAgent,
        requestDelayMs: opts.delayMs,
        concurrency: opts.concurrency,
        retries: opts.retries,
        timeoutMs: opts.requestTimeoutMs,
        checkpointEvery: opts.checkpointEvery,
        creditPolicy: "Keep solveUrl/sourcePage and reconstructor attribution in downstream outputs.",
      },
      parameters: {
        offset: opts.offset,
        limit: opts.limit,
        puzzle: opts.puzzle,
        concurrency: opts.concurrency,
        delayMs: opts.delayMs,
        retries: opts.retries,
        requestTimeoutMs: opts.requestTimeoutMs,
        checkpointEvery: opts.checkpointEvery,
        resume: opts.resume,
        userAgent: opts.userAgent,
      },
      totals: {
        selected: selected.length,
        pending: pending.length,
        fetched: fetchedCount,
        skipped: skippedCount,
        ok: okCount,
        failed: failedCount,
      },
      qualityReport: summarizeQuality(records),
      records,
    };
  }

  async function writeCheckpoint(reason) {
    const payload = buildPayload();
    writeOutput(opts.output, payload);
    console.log(`${reason}: wrote ${opts.output}`);
  }

  let nextPendingIndex = 0;
  async function workerLoop(workerId) {
    while (true) {
      const queueIndex = nextPendingIndex;
      nextPendingIndex += 1;
      if (queueIndex >= pending.length) break;

      const source = pending[queueIndex];
      const id = Number(source.id);
      const solveUrl = source.solveUrl || `https://reco.nz/solve/${id}`;
      const startedAt = Date.now();

      try {
        const html = await fetchWithRetries(solveUrl, headers, opts.retries, opts.requestTimeoutMs);
        const details = parseSolveDetails(html, source);
        const record = {
          ...details,
          ok: true,
          fetchedAt: new Date().toISOString(),
          fetchMs: Date.now() - startedAt,
        };
        outputById.set(id, record);
        fetchedCount += 1;
        okCount += 1;
        const completed = skippedCount + fetchedCount;
        console.log(`[${completed}/${selected.length}] #${workerId} id=${id} ok (${record.fetchMs}ms)`);
      } catch (error) {
        const record = {
          id,
          solveUrl,
          sourcePage: source.sourcePage ?? null,
          method: source.method || "",
          tags: source.tags || "",
          puzzle: source.puzzle || "",
          ok: false,
          error: String(error?.message || error),
          fetchedAt: new Date().toISOString(),
          fetchMs: Date.now() - startedAt,
        };
        outputById.set(id, record);
        fetchedCount += 1;
        failedCount += 1;
        const completed = skippedCount + fetchedCount;
        console.warn(`[${completed}/${selected.length}] #${workerId} id=${id} failed: ${record.error}`);
      }

      if (fetchedCount > 0 && fetchedCount % opts.checkpointEvery === 0) {
        await writeCheckpoint("checkpoint");
      }

      if (opts.delayMs > 0) {
        await sleep(opts.delayMs);
      }
    }
  }

  const workerCount = Math.min(Math.max(1, opts.concurrency), Math.max(1, pending.length));
  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(workerLoop(i + 1));
  }
  await Promise.all(workers);

  const payload = buildPayload();

  writeOutput(opts.output, payload);
  console.log(`Wrote ${opts.output} (${payload.records.length} records)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
