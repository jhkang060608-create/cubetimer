import { cube2x2x2, cube3x3x3 } from "../vendor/cubing/puzzles/index.js";

const puzzleCache = new Map();

async function warmupPuzzle(eventId) {
  // In our vendored cubing build, puzzle loaders are exported as objects (not functions).
  // Keep a tiny compatibility shim in case we ever swap to a function-based export.
  const rawLoader = eventId === "333" ? cube3x3x3 : cube2x2x2;
  const loader = typeof rawLoader === "function" ? await rawLoader() : rawLoader;
  const puzzle = await loader.kpuzzle();
  return {
    puzzle,
    defaultPattern: puzzle.defaultPattern(),
  };
}

async function ensurePuzzleLoaded(eventId = "222") {
  if (!puzzleCache.has(eventId)) {
    const promise = warmupPuzzle(eventId).catch((error) => {
      puzzleCache.delete(eventId);
      throw error;
    });
    puzzleCache.set(eventId, promise);
  }
  return await puzzleCache.get(eventId);
}

export async function ensureSolverReady(eventId) {
  await ensurePuzzleLoaded(eventId);
}

export async function getSolverPuzzle(eventId) {
  const { puzzle } = await ensurePuzzleLoaded(eventId);
  return puzzle;
}

export async function getDefaultPattern(eventId) {
  const { defaultPattern } = await ensurePuzzleLoaded(eventId);
  return defaultPattern;
}
