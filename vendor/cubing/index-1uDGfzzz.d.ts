import { s as Alg, K as KPattern, v as KPuzzle } from './PuzzleLoader-BskBhUgu.js';

declare enum PrefetchLevel {
    Auto = "auto",
    None = "none",
    Immediate = "immediate"
}

declare function randomScrambleForEvent(eventID: string): Promise<Alg>;
declare function experimentalSolve3x3x3IgnoringCenters(pattern: KPattern): Promise<Alg>;
declare function experimentalSolve2x2x2(pattern: KPattern): Promise<Alg>;
declare function solveSkewb(pattern: KPattern): Promise<Alg>;
declare function solvePyraminx(pattern: KPattern): Promise<Alg>;
declare function solveMegaminx(pattern: KPattern): Promise<Alg>;
interface SolveTwsearchOptions {
    generatorMoves?: string[];
    targetPattern?: KPattern;
    minDepth?: number;
    maxDepth?: number;
}
declare function solveTwsearch(kpuzzle: KPuzzle, pattern: KPattern, options?: SolveTwsearchOptions): Promise<Alg>;
interface SearchOutsideDebugGlobals {
    logPerf: boolean;
    scramblePrefetchLevel: `${PrefetchLevel}`;
    disableStringWorker: boolean;
    forceNewWorkerForEveryScramble: boolean;
    showWorkerInstantiationWarnings: boolean;
}
declare function setSearchDebug(options: Partial<SearchOutsideDebugGlobals>): void;

export { experimentalSolve3x3x3IgnoringCenters as a, solveMegaminx as b, solvePyraminx as c, solveSkewb as d, experimentalSolve2x2x2 as e, solveTwsearch as f, randomScrambleForEvent as r, setSearchDebug as s };
