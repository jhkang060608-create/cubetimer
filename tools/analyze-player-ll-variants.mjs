import { readFile } from 'fs/promises';

function norm(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

async function main() {
  const path = new URL('../vendor-data/reco/reco-3x3-f2l-ll-prediction.json', import.meta.url);
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  const players = Array.isArray(parsed.playerDownstreamProfiles) ? parsed.playerDownstreamProfiles : [];

  for (const p of players) {
    const solver = norm(p.solver || p.name || 'UNKNOWN');
    const canonicalMap = new Map();

    const states = Array.isArray(p.states) ? p.states : [];
    for (const s of states) {
      // topFormulas are treated as canonical entries
      if (Array.isArray(s.topFormulas)) {
        for (const tf of s.topFormulas) {
          const canon = norm(tf.canonicalFormula || tf.formula || tf.algorithm || tf.formulaKey || '');
          const family = String(tf.family || '').trim();
          const count = Number(tf.count || tf.sampleCount || 0) || 0;
          if (!canon || !count) continue;
          if (!canonicalMap.has(canon)) canonicalMap.set(canon, { total: 0, family, variants: new Map() });
          const entry = canonicalMap.get(canon);
          entry.total += count;
          entry.variants.set(canon, (entry.variants.get(canon) || 0) + count);
        }
      }
      // topFormulaVariants provide variant->canonical relationships
      if (Array.isArray(s.topFormulaVariants)) {
        for (const v of s.topFormulaVariants) {
          const canonical = norm(v.canonicalFormula || v.canonical || v.canonicalKey || '');
          const variant = norm(v.formula || v.variant || v.formula || '');
          const family = String(v.family || '').trim();
          const count = Number(v.count || 0) || 0;
          if (!variant || !count) continue;
          const key = canonical || variant;
          if (!canonicalMap.has(key)) canonicalMap.set(key, { total: 0, family, variants: new Map() });
          const entry = canonicalMap.get(key);
          entry.total += count;
          entry.variants.set(variant, (entry.variants.get(variant) || 0) + count);
        }
      }
    }

    const sorted = Array.from(canonicalMap.entries())
      .map(([canon, obj]) => ({ canon, total: obj.total, family: obj.family, variants: Array.from(obj.variants.entries()) }))
      .sort((a, b) => b.total - a.total || a.canon.localeCompare(b.canon));

    console.log(`Player: ${solver} (states: ${Array.isArray(p.states) ? p.states.length : 0}, solves: ${p.solveCount || 0})`);
    const topN = Math.min(20, sorted.length);
    for (let i = 0; i < topN; i++) {
      const item = sorted[i];
      console.log(`${i + 1}. [${item.family || 'UNK'}] ${item.canon} — total:${item.total}`);
      item.variants.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      for (const [variant, cnt] of item.variants) {
        console.log(`    - ${variant} (${cnt})`);
      }
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
