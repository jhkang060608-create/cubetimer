import fs from 'fs/promises';
import path from 'path';

const ROOT = process.cwd();
const RECO_PATH = path.join(ROOT, 'vendor-data/reco/reco-3x3-f2l-ll-prediction.json');

function splitMoves(alg) {
  if (!alg || typeof alg !== 'string') return [];
  return alg
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function normalizeMoveToken(token) {
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(String(token || '').trim());
  if (!match) return '';
  const face = match[1];
  const suffix = match[2] || '';
  if (!face) return '';
  if (suffix === "2'" || suffix === '2') return `${face}2`;
  if (suffix === "'") return `${face}'`;
  return face;
}
function stripOuterFrameRotations(tokens) {
  const FRAME_ROTATION_TOKENS = new Set(['x', 'x2', "x'", 'z', 'z2', "z'"]);
  let start = 0;
  let end = Array.isArray(tokens) ? tokens.length : 0;
  while (start < end && FRAME_ROTATION_TOKENS.has(tokens[start])) start += 1;
  while (end > start && FRAME_ROTATION_TOKENS.has(tokens[end - 1])) end -= 1;
  return tokens.slice(start, end);
}
function normalizeFormulaMatchText(text) {
  const tokens = splitMoves(text)
    .map((token) => normalizeMoveToken(token))
    .filter(Boolean);
  return stripOuterFrameRotations(tokens).join(' ');
}

function buildPriorityMapFromState(topFormulas, topVariants, params) {
  const map = new Map();
  const { variantWeight = 1, canonicalAliasWeight = 1, canonicalBoost = 1 } = params;

  // topFormulas: add counts (raw + normalized), optionally boosted
  for (const f of Array.isArray(topFormulas) ? topFormulas : []) {
    const formula = String(f.formula || '').trim();
    const count = Number(f.count || 0);
    if (!formula || !Number.isFinite(count) || count <= 0) continue;
    const norm = normalizeFormulaMatchText(formula) || formula;
    const add = count * canonicalBoost;
    map.set(formula, (map.get(formula) || 0) + add);
    map.set(norm, (map.get(norm) || 0) + add);
  }

  // topVariants: add variant counts with variantWeight, and add to canonical normalized key with canonicalAliasWeight
  for (const v of Array.isArray(topVariants) ? topVariants : []) {
    const variantFormula = String(v.formula || v.variant || '').trim();
    const canonicalFormula = String(v.canonicalFormula || v.canonical || '').trim();
    const count = Number(v.count || 0);
    if (!variantFormula || !Number.isFinite(count) || count <= 0) continue;
    const vNorm = normalizeFormulaMatchText(variantFormula) || variantFormula;
    const cNorm = canonicalFormula ? normalizeFormulaMatchText(canonicalFormula) || canonicalFormula : null;
    const vAdd = count * variantWeight;
    map.set(variantFormula, (map.get(variantFormula) || 0) + vAdd);
    map.set(vNorm, (map.get(vNorm) || 0) + vAdd);
    if (cNorm) {
      map.set(cNorm, (map.get(cNorm) || 0) + count * canonicalAliasWeight);
    }
  }
  return map;
}

async function main() {
  const doc = JSON.parse(await fs.readFile(RECO_PATH, 'utf8'));
  const players = Array.isArray(doc?.playerDownstreamProfiles) ? doc.playerDownstreamProfiles : [];

  const variantWeightGrid = [0.5, 1, 2];
  const canonicalAliasGrid = [0, 0.5, 1];
  const canonicalBoostGrid = [1, 1.25, 1.5];

  const results = [];

  for (const variantWeight of variantWeightGrid) {
    for (const canonicalAliasWeight of canonicalAliasGrid) {
      for (const canonicalBoost of canonicalBoostGrid) {
        const params = { variantWeight, canonicalAliasWeight, canonicalBoost };
        let totalCases = 0;
        let hits = 0;
        for (const player of players) {
          const states = Array.isArray(player.states) ? player.states : [];
          for (const st of states) {
            const topVariants = Array.isArray(st.topFormulaVariants) ? st.topFormulaVariants : [];
            if (!topVariants.length) continue;
            // find canonical groups: map canonicalNormalized -> { canonicalFormula, variants: [] }
            const groups = new Map();
            for (const v of topVariants) {
              const canonical = v.canonicalFormula || v.canonicalFormula || v.canonical || v.canonicalKey || v.canonicalFormula;
              const canonicalStr = String(canonical || '').trim();
              const canonicalNorm = canonicalStr ? normalizeFormulaMatchText(canonicalStr) : null;
              const varFormula = String(v.formula || v.variant || '').trim();
              if (!varFormula) continue;
              const key = canonicalNorm || normalizeFormulaMatchText(varFormula) || varFormula;
              if (!groups.has(key)) groups.set(key, { canonical: canonicalStr || null, variants: [] });
              groups.get(key).variants.push({ formula: varFormula, count: Number(v.count || 0) });
            }
            if (!groups.size) continue;

            // For each canonical group, build priority map using topFormulas & topVariants for this state
            const topFormulas = Array.isArray(st.topFormulas) ? st.topFormulas : [];
            const map = buildPriorityMapFromState(topFormulas, topVariants, params);

            for (const [gk, group] of groups.entries()) {
              // ground truth: top variant by count
              const gt = group.variants.slice().sort((a,b)=>b.count-a.count)[0];
              if (!gt) continue;
              totalCases += 1;

              // candidate keys: canonical raw, canonical norm, each variant raw & norm
              const candidateKeys = new Set();
              if (group.canonical) candidateKeys.add(group.canonical);
              if (group.canonical) candidateKeys.add(normalizeFormulaMatchText(group.canonical));
              for (const vv of group.variants) {
                candidateKeys.add(vv.formula);
                candidateKeys.add(normalizeFormulaMatchText(vv.formula));
              }
              // pick best scoring candidate according to map
              let bestKey = null;
              let bestScore = -Infinity;
              for (const k of candidateKeys) {
                if (!k) continue;
                const score = Number(map.get(k) || 0);
                if (score > bestScore || (score === bestScore && String(k) < String(bestKey))) {
                  bestScore = score;
                  bestKey = k;
                }
              }
              const predNorm = normalizeFormulaMatchText(bestKey || '');
              const gtNorm = normalizeFormulaMatchText(gt.formula || '');
              if (predNorm && gtNorm && predNorm === gtNorm) hits += 1;
            }
          }
        }
        const accuracy = totalCases > 0 ? hits / totalCases : 0;
        results.push({ params, totalCases, hits, accuracy });
      }
    }
  }

  results.sort((a,b)=>b.accuracy - a.accuracy || b.totalCases - a.totalCases);
  console.log('Top results (accuracy desc):');
  console.log('params, accuracy, hits/totalCases');
  for (let i=0;i<Math.min(10, results.length); i++) {
    const r = results[i];
    console.log(`${JSON.stringify(r.params)} ${ (r.accuracy*100).toFixed(2) }% ${r.hits}/${r.totalCases}`);
  }
  // also print best full row
  const best = results[0];
  console.log('\nBest params full:', JSON.stringify(best, null, 2));
}

main().catch((err)=>{ console.error(err); process.exitCode = 2; });
