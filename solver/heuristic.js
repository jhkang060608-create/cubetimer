import { getDefaultPattern } from "./context.js";

const cacheMap = new Map();
const cachePromiseMap = new Map();
const HEURISTIC_CACHE_LIMIT = 50000;
const TRACKED_ORBIT_NAMES = ["CORNERS", "EDGES"];

async function buildCache(eventId) {
  const solved = await getDefaultPattern(eventId);
  const data = solved.patternData ?? {};
  const trackedOrbits = [];

  for (let i = 0; i < TRACKED_ORBIT_NAMES.length; i++) {
    const orbitName = TRACKED_ORBIT_NAMES[i];
    const orbit = data[orbitName];
    if (!orbit || !Array.isArray(orbit.pieces)) continue;

    trackedOrbits.push({
      orbitName,
      solvedPieces: orbit.pieces.slice(),
      solvedOrientation: Array.isArray(orbit.orientation) ? orbit.orientation.slice() : null,
      pieceCount: orbit.pieces.length,
    });
  }

  return {
    trackedOrbits,
    stateHeuristicCache: new Map(),
  };
}

async function ensureCache(eventId) {
  const cached = cacheMap.get(eventId);
  if (cached) return cached;

  let cachePromise = cachePromiseMap.get(eventId);
  if (!cachePromise) {
    cachePromise = buildCache(eventId)
      .then((cache) => {
        cacheMap.set(eventId, cache);
        cachePromiseMap.delete(eventId);
        return cache;
      })
      .catch((error) => {
        cachePromiseMap.delete(eventId);
        throw error;
      });
    cachePromiseMap.set(eventId, cachePromise);
  }

  return await cachePromise;
}

function buildHeuristicKey(trackedOrbits, patternData) {
  const keyParts = new Array(trackedOrbits.length);

  for (let i = 0; i < trackedOrbits.length; i++) {
    const { orbitName } = trackedOrbits[i];
    const orbit = patternData[orbitName];
    if (!orbit) {
      keyParts[i] = `${orbitName}:`;
      continue;
    }

    const piecesKey = Array.isArray(orbit.pieces) ? orbit.pieces.join(",") : "";
    const orientationKey = Array.isArray(orbit.orientation) ? orbit.orientation.join(",") : "";
    keyParts[i] = `${orbitName}:${piecesKey}|${orientationKey}`;
  }

  return keyParts.join(";");
}

export async function estimateDistance(state) {
  const { eventId } = state;
  const cache = await ensureCache(eventId);
  const patternData = state.pattern.patternData;
  if (!patternData) return 0;

  const { trackedOrbits, stateHeuristicCache } = cache;
  const heuristicKey = buildHeuristicKey(trackedOrbits, patternData);
  const cached = stateHeuristicCache.get(heuristicKey);
  if (typeof cached === "number") return cached;

  // Lower bound aggregation:
  // - CORNERS/EDGES are each bounded by ceil(mismatches / 4) because one face turn affects at most 4.
  // - Combined bound uses ceil((corner+edge mismatches) / 8).
  let heuristic = 0;
  let combinedPermutationMismatch = 0;
  let combinedOrientationMismatch = 0;

  for (let orbitIndex = 0; orbitIndex < trackedOrbits.length; orbitIndex++) {
    const orbitCache = trackedOrbits[orbitIndex];
    const current = patternData[orbitCache.orbitName];
    if (!current) continue;

    const currentPieces = current.pieces;
    const currentOrientation = Array.isArray(current.orientation) ? current.orientation : null;
    let permutationMismatch = 0;
    let orientationMismatch = 0;

    for (let i = 0; i < orbitCache.pieceCount; i++) {
      if (currentPieces[i] !== orbitCache.solvedPieces[i]) {
        permutationMismatch += 1;
      }
      if (orbitCache.solvedOrientation && currentOrientation) {
        if (currentOrientation[i] !== orbitCache.solvedOrientation[i]) {
          orientationMismatch += 1;
        }
      }
    }

    combinedPermutationMismatch += permutationMismatch;
    combinedOrientationMismatch += orientationMismatch;

    const orbitPermutationBound = (permutationMismatch + 3) >> 2;
    const orbitOrientationBound = (orientationMismatch + 3) >> 2;
    heuristic = Math.max(heuristic, orbitPermutationBound, orbitOrientationBound);
  }

  if (combinedPermutationMismatch > 0 || combinedOrientationMismatch > 0) {
    const combinedPermBound = (combinedPermutationMismatch + 7) >> 3;
    const combinedOriBound = (combinedOrientationMismatch + 7) >> 3;
    heuristic = Math.max(heuristic, combinedPermBound, combinedOriBound);
  }

  if (stateHeuristicCache.size >= HEURISTIC_CACHE_LIMIT) {
    stateHeuristicCache.clear();
  }
  stateHeuristicCache.set(heuristicKey, heuristic);
  return heuristic;
}
