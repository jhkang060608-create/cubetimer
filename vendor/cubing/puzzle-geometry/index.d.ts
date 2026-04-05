import { P as Perm } from '../PuzzleLoader-BskBhUgu.js';
export { j as EXPERIMENTAL_PUZZLE_BASE_SHAPES, k as EXPERIMENTAL_PUZZLE_CUT_TYPES, i as ExperimentalPGNotation, l as ExperimentalPuzzleBaseShape, m as ExperimentalPuzzleCutDescription, n as ExperimentalPuzzleCutType, o as ExperimentalPuzzleDescription, a as ExperimentalPuzzleGeometryOptions, q as PuzzleGeometry, Q as Quat, S as StickerDat, b as StickerDatAxis, c as StickerDatFace, d as StickerDatSticker, g as getPG3DNamedPuzzles, e as getPuzzleDescriptionString, f as getPuzzleGeometryByDesc, h as getPuzzleGeometryByName, p as parseOptions, r as parsePuzzleDescription } from '../PuzzleLoader-BskBhUgu.js';
import 'three/src/Three.js';

declare function schreierSims(g: Perm[], disp: (s: string) => void): bigint;

export { schreierSims };
