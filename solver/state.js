import { ensureSolverReady, getDefaultPattern } from "./context.js";

export class SolverState {
  constructor(pattern, eventId, solvedPattern = null) {
    this.pattern = pattern;
    this.eventId = eventId;
    this.solvedPattern = solvedPattern;
  }

  static async fromScramble(scramble, eventId) {
    await ensureSolverReady(eventId);
    const solved = await getDefaultPattern(eventId);
    const pattern = scramble ? solved.applyAlg(scramble) : solved;
    return new SolverState(pattern, eventId, solved);
  }

  applyMove(move) {
    return new SolverState(this.pattern.applyMove(move), this.eventId, this.solvedPattern);
  }

  async isSolved() {
    const solved = this.solvedPattern || (await getDefaultPattern(this.eventId));
    return this.pattern.isIdentical(solved);
  }
}

export async function createSolvedState(eventId) {
  await ensureSolverReady(eventId);
  const solved = await getDefaultPattern(eventId);
  return new SolverState(solved, eventId, solved);
}
