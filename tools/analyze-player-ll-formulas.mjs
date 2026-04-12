import { readFile } from 'fs/promises';

function safeString(x) {
  return String(x || '').trim();
}

function normalizeCanonical(form) {
  if (!form) return '';
  return form.replace(/\s+/g, ' ').trim();
}

async function main() {
  const path = new URL('../vendor-data/reco/reco-3x3-f2l-ll-prediction.json', import.meta.url);
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  const players = Array.isArray(parsed.playerDownstreamProfiles) ? parsed.playerDownstreamProfiles : [];
  for (const p of players) {
    const solver = safeString(p.solver || p.name || 'UNKNOWN');
    const solveCount = Number(p.solveCount || 0);
    const agg = new Map();
    const states = Array.isArray(p.states) ? p.states : [];
    for (const s of states) {
      if (Array.isArray(s.topFormulas)) {
        for (const tf of s.topFormulas) {
          const formula = normalizeCanonical(safeString(tf.formula || tf.algorithm || tf.formulaKey));
          const count = Number(tf.count || tf.sampleCount || 0);
          if (!formula || !count) continue;
          agg.set(formula, (agg.get(formula) || 0) + count);
        }
      }
      if (Array.isArray(s.topFormulaVariants)) {
        for (const v of s.topFormulaVariants) {
          const canonical = normalizeCanonical(safeString(v.canonicalFormula || v.canonical));
          const count = Number(v.count || 0);
          const key = canonical || normalizeCanonical(safeString(v.formula));
          if (!key || !count) continue;
          agg.set(key, (agg.get(key) || 0) + count);
        }
      }
    }

    const arr = Array.from(agg.entries()).map(([formula, count]) => ({ formula, count }));
    arr.sort((a, b) => b.count - a.count || a.formula.localeCompare(b.formula));

    console.log(`Player: ${solver} (solves: ${solveCount})`);
    const topN = Math.min(20, arr.length);
    for (let i = 0; i < topN; i++) {
      const item = arr[i];
      console.log(`${i + 1}. ${item.formula} — ${item.count}`);
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
