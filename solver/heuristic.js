import { getDefaultPattern } from "./context.js";

const cacheMap = new Map();
const HEURISTIC_CACHE_LIMIT = 50000;

async function ensureCache(eventId) {
  if (cacheMap.has(eventId)) return cacheMap.get(eventId);

  const solved = await getDefaultPattern(eventId);
  const data = solved.patternData;
  const trackedOrbits = ["CORNERS", "EDGES"].filter((orbitName) => {
    const orbit = data?.[orbitName];
    return orbit && Array.isArray(orbit.pieces);
  });

  const solvedOrbits = {};
  for (const orbitName of trackedOrbits) {
    const orbit = data[orbitName];
    solvedOrbits[orbitName] = {
      pieces: orbit.pieces.slice(),
      orientation: Array.isArray(orbit.orientation) ? orbit.orientation.slice() : null,
    };
  }

  const cache = {
    solvedOrbits,
    trackedOrbits,
    stateHeuristicCache: new Map(),
  };
  cacheMap.set(eventId, cache);
  return cache;
}

export async function estimateDistance(state) {
  const { eventId } = state;
  const cache = await ensureCache(eventId);
  const patternData = state.pattern.patternData;
  if (!patternData) return 0;

  const heuristicKey = cache.trackedOrbits
    .map((orbitName) => {
      const orbit = patternData[orbitName];
      if (!orbit) return `${orbitName}:`;
      const piecesKey = Array.isArray(orbit.pieces) ? orbit.pieces.join(",") : "";
      const orientationKey = Array.isArray(orbit.orientation) ? orbit.orientation.join(",") : "";
      return `${orbitName}:${piecesKey}|${orientationKey}`;
    })
    .join(";");
  const cached = cache.stateHeuristicCache.get(heuristicKey);
  if (typeof cached === "number") return cached;

  // Lower bound aggregation:
  // - CORNERS/EDGES are each bounded by ceil(mismatches / 4) because one face turn affects at most 4.
  // - Combined bound uses ceil((corner+edge mismatches) / 8).
  let heuristic = 0;
  let combinedPermutationMismatch = 0;
  let combinedOrientationMismatch = 0;

  for (const orbitName of cache.trackedOrbits) {
    const current = patternData[orbitName];
    const solved = cache.solvedOrbits[orbitName];
    if (!current || !solved) continue;

    let permutationMismatch = 0;
    let orientationMismatch = 0;

    for (let i = 0; i < solved.pieces.length; i++) {
      if (current.pieces[i] !== solved.pieces[i]) {
        permutationMismatch += 1;
      }
      if (solved.orientation && Array.isArray(current.orientation)) {
        if (current.orientation[i] !== solved.orientation[i]) {
          orientationMismatch += 1;
        }
      }
    }

    combinedPermutationMismatch += permutationMismatch;
    combinedOrientationMismatch += orientationMismatch;

    const orbitPermutationBound = Math.ceil(permutationMismatch / 4);
    const orbitOrientationBound = Math.ceil(orientationMismatch / 4);
    heuristic = Math.max(heuristic, orbitPermutationBound, orbitOrientationBound);
  }

  if (combinedPermutationMismatch > 0 || combinedOrientationMismatch > 0) {
    const combinedPermBound = Math.ceil(combinedPermutationMismatch / 8);
    const combinedOriBound = Math.ceil(combinedOrientationMismatch / 8);
    heuristic = Math.max(heuristic, combinedPermBound, combinedOriBound);
  }

  if (cache.stateHeuristicCache.size >= HEURISTIC_CACHE_LIMIT) {
    cache.stateHeuristicCache.clear();
  }
  cache.stateHeuristicCache.set(heuristicKey, heuristic);
  return heuristic;
}
