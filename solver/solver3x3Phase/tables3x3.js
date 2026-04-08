import { MOVE_NAMES } from "../moves.js";
import { getDefaultPattern } from "../context.js";

let initPromise = null;
let solvedPattern = null;
let cornerPermMap = null;
let cornerOriDelta = null;
let edgePermMap = null;
let edgeOriDelta = null;
let moveFace = null;

const FACE_TO_INDEX = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };

async function initialize() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    solvedPattern = await getDefaultPattern("333");
    cornerPermMap = new Uint8Array(MOVE_NAMES.length * 8);
    cornerOriDelta = new Uint8Array(MOVE_NAMES.length * 8);
    edgePermMap = new Uint8Array(MOVE_NAMES.length * 12);
    edgeOriDelta = new Uint8Array(MOVE_NAMES.length * 12);
    moveFace = new Uint8Array(MOVE_NAMES.length);

    for (let m = 0; m < MOVE_NAMES.length; m++) {
      const moved = solvedPattern.applyMove(MOVE_NAMES[m]).patternData;
      moveFace[m] = FACE_TO_INDEX[MOVE_NAMES[m][0]];
      for (let i = 0; i < 8; i++) {
        cornerPermMap[m * 8 + i] = moved.CORNERS.pieces[i];
        cornerOriDelta[m * 8 + i] = moved.CORNERS.orientation[i];
      }
      for (let i = 0; i < 12; i++) {
        edgePermMap[m * 12 + i] = moved.EDGES.pieces[i];
        edgeOriDelta[m * 12 + i] = moved.EDGES.orientation[i];
      }
    }
  })();
  return initPromise;
}

export async function get3x3MoveTables() {
  await initialize();
  return {
    MOVE_NAMES,
    solvedPattern,
    cornerPermMap,
    cornerOriDelta,
    edgePermMap,
    edgeOriDelta,
    moveFace,
  };
}

