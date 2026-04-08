let searchModulesPromise = null;
const warmupMap = new Map();

async function getExternalModules() {
  if (!searchModulesPromise) {
    searchModulesPromise = Promise.all([
      import("../vendor/cubing/search/index.js"),
      import("../vendor/cubing/notation/index.js"),
      import("./context.js"),
    ]);
  }
  return searchModulesPromise;
}

export async function solveWithExternalSearch(scramble, eventId) {
  const [{ experimentalSolve2x2x2, experimentalSolve3x3x3IgnoringCenters }, { countMoves }, { getDefaultPattern }] =
    await getExternalModules();

  const solved = await getDefaultPattern(eventId);
  const pattern = scramble ? solved.applyAlg(scramble) : solved;
  const alg =
    eventId === "333"
      ? await experimentalSolve3x3x3IgnoringCenters(pattern)
      : await experimentalSolve2x2x2(pattern);
  const solution = alg?.toString?.() || "";
  const moveCount = typeof countMoves === "function" ? countMoves(alg) : solution.split(/\s+/).filter(Boolean).length;

  return {
    ok: true,
    solution,
    moveCount,
    nodes: 0,
    bound: 0,
    source: "EXTERNAL_CUBING_SEARCH",
  };
}

export function prewarmExternalSearch(eventId) {
  if (warmupMap.has(eventId)) return warmupMap.get(eventId);
  const promise = (async () => {
    try {
      await solveWithExternalSearch("R U R' U'", eventId);
    } catch (_) {
      // Warmup is best-effort.
    }
  })();
  warmupMap.set(eventId, promise);
  return promise;
}

