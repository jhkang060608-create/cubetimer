import { ensureSolverReady, getDefaultPattern } from "./context.js";

export class SolverState {
  constructor(pattern, eventId) {
    this.pattern = pattern;
    this.eventId = eventId;
  }

  static async fromScramble(scramble, eventId) {
    await ensureSolverReady(eventId);
    const solved = await getDefaultPattern(eventId);
    const pattern = scramble ? solved.applyAlg(scramble) : solved;
    return new SolverState(pattern, eventId);
  }

  applyMove(move) {
    return new SolverState(this.pattern.applyMove(move), this.eventId);
  }

  async isSolved() {
    const solved = await getDefaultPattern(this.eventId);
    return this.pattern.isIdentical(solved);
  }
}

export async function createSolvedState(eventId) {
  await ensureSolverReady(eventId);
  return new SolverState(await getDefaultPattern(eventId), eventId);
}
