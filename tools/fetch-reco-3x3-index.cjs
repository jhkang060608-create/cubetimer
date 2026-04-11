#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "vendor-data", "reco", "reco-3x3-index.json");
const SCHEMA_VERSION = "reco-index.v1";
const DATA_CONTRACT = Object.freeze({
  requiredFields: ["solver", "method", "result"],
  optionalFields: ["tags", "moveCount", "tps", "reconstructedBy", "competition"],
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
  const i = Math.floor(n);
  return i;
}

function parseArgs(argv) {
  const opts = {
    startPage: 1,
    endPage: 30,
    delayMs: 250,
    stopOnEmpty: 0,
    puzzle: "3x3",
    output: DEFAULT_OUTPUT,
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

    if (flag === "--start-page") {
      opts.startPage = parseIntOrFallback(value, opts.startPage);
      if (consumeNext) i += 1;
    } else if (flag === "--end-page") {
      opts.endPage = parseIntOrFallback(value, opts.endPage);
      if (consumeNext) i += 1;
    } else if (flag === "--delay-ms") {
      opts.delayMs = parseIntOrFallback(value, opts.delayMs);
      if (consumeNext) i += 1;
    } else if (flag === "--stop-on-empty") {
      opts.stopOnEmpty = parseIntOrFallback(value, opts.stopOnEmpty);
      if (consumeNext) i += 1;
    } else if (flag === "--puzzle") {
      opts.puzzle = normalizePuzzleFilter(value);
      if (consumeNext) i += 1;
    } else if (flag === "--output") {
      opts.output = value || opts.output;
      if (consumeNext) i += 1;
    } else if (flag === "--user-agent") {
      opts.userAgent = value || opts.userAgent;
      if (consumeNext) i += 1;
    }
  }

  opts.startPage = Math.max(1, opts.startPage);
  opts.endPage = Math.max(opts.startPage, opts.endPage);
  opts.delayMs = Math.max(0, opts.delayMs);
  opts.stopOnEmpty = Math.max(0, opts.stopOnEmpty);
  opts.puzzle = normalizePuzzleFilter(opts.puzzle);
  return opts;
}

function printHelp() {
  console.log("Usage: node tools/fetch-reco-3x3-index.cjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --start-page <n>     Start page (default: 1)");
  console.log("  --end-page <n>       End page (default: 30)");
  console.log("  --delay-ms <n>       Delay between requests (default: 250)");
  console.log("  --stop-on-empty <n>  Stop after N consecutive empty pages (default: 0=disabled)");
  console.log("  --puzzle <name|all>  Puzzle filter (default: 3x3)");
  console.log("  --output <path>      Output JSON path");
  console.log("  --user-agent <text>  User-Agent header");
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
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function toNumberOrNull(text) {
  const n = Number.parseFloat(String(text || "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(text) {
  const n = Number.parseInt(String(text || "").replace(/[^0-9\-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseRowsFromPage(html, page, puzzleFilter) {
  const out = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cellMatches = [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cellMatches.length < 11) continue;

    const cols = cellMatches.map((m) => stripTags(m[1]));
    const solveLinkMatch = rowHtml.match(/href\s*=\s*["'](?:https?:\/\/reco\.nz)?\/solve\/(\d+)["']/i);
    const id = solveLinkMatch
      ? Number.parseInt(solveLinkMatch[1], 10)
      : Number.parseInt(cols[0], 10);
    if (!Number.isFinite(id)) continue;

    const puzzle = cols[1] || "";
    if (puzzleFilter !== "all" && puzzle !== puzzleFilter) continue;

    out.push({
      id,
      puzzle,
      result: cols[2] || "",
      resultSeconds: toNumberOrNull(cols[2]),
      solver: cols[3] || "",
      method: cols[4] || "",
      date: cols[5] || "",
      competition: cols[6] || "",
      tags: cols[7] || "",
      moveCount: toIntOrNull(cols[8]),
      tps: toNumberOrNull(cols[9]),
      reconstructedBy: cols[10] || "",
      solveUrl: `https://reco.nz/solve/${id}`,
      sourcePage: page,
    });
  }

  return out;
}

function fetchTextViaHttps(url, headers, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectCount >= 5) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        resolve(fetchTextViaHttps(nextUrl, headers, redirectCount + 1));
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
    req.on("error", reject);
  });
}

async function fetchText(url, headers) {
  if (typeof fetch === "function") {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
  }
  return fetchTextViaHttps(url, headers);
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const headers = {
    "user-agent": opts.userAgent,
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
  };

  const byId = new Map();
  const pages = [];
  let emptyStreak = 0;

  for (let page = opts.startPage; page <= opts.endPage; page++) {
    const url = `https://reco.nz/?page=${page}`;
    try {
      const html = await fetchText(url, headers);
      const rows = parseRowsFromPage(html, page, opts.puzzle);
      pages.push({ page, url, count: rows.length });

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!byId.has(row.id)) {
          byId.set(row.id, row);
        }
      }

      if (rows.length === 0) {
        emptyStreak += 1;
      } else {
        emptyStreak = 0;
      }

      console.log(`[page ${page}] ${opts.puzzle} rows=${rows.length}, unique=${byId.size}`);

      if (opts.stopOnEmpty > 0 && emptyStreak >= opts.stopOnEmpty) {
        console.log(`Stopping early after ${emptyStreak} empty pages.`);
        break;
      }
    } catch (error) {
      pages.push({ page, url, count: 0, error: String(error?.message || error) });
      console.warn(`[page ${page}] failed: ${error?.message || error}`);
    }

    if (page < opts.endPage) {
      await sleep(opts.delayMs);
    }
  }

  const records = Array.from(byId.values()).sort((a, b) => b.id - a.id);
  const failedPages = pages.filter((entry) => !!entry.error).length;
  const pagesWithRows = pages.filter((entry) => Number(entry.count || 0) > 0).length;
  const payload = {
    generatedAt: new Date().toISOString(),
    source: "https://reco.nz/",
    schemaVersion: SCHEMA_VERSION,
    puzzle: opts.puzzle,
    dataContract: DATA_CONTRACT,
    crawlPolicy: {
      userAgent: opts.userAgent,
      requestDelayMs: opts.delayMs,
      rateLimitNote: "Respect reco.nz capacity and avoid burst traffic.",
      creditPolicy: "Preserve source URL and reconstructor attribution in downstream datasets.",
    },
    parameters: {
      startPage: opts.startPage,
      endPage: opts.endPage,
      delayMs: opts.delayMs,
      stopOnEmpty: opts.stopOnEmpty,
      puzzle: opts.puzzle,
      userAgent: opts.userAgent,
    },
    pageCount: pages.length,
    recordCount: records.length,
    qualityReport: {
      failedPages,
      failedPageRate: pages.length > 0 ? failedPages / pages.length : 0,
      pagesWithRows,
      pageCoverageRate: pages.length > 0 ? pagesWithRows / pages.length : 0,
    },
    pages,
    records,
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.writeFileSync(opts.output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${opts.output} (${records.length} records)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
