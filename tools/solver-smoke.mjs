#!/usr/bin/env node
// Run: node tools/solver-smoke.mjs [--random-count N] [--random-length N] [--include-2x2]

import { SolverState } from "../solver/state.js";
import { solveScramble } from "../solver/search.js";

const THREE_BY_THREE_MOVES = [
  "U", "U2", "U'",
  "R", "R2", "R'",
  "F", "F2", "F'",
  "D", "D2", "D'",
  "L", "L2", "L'",
  "B", "B2", "B'",
];

const TWO_BY_TWO_MOVES = THREE_BY_THREE_MOVES;

const fixedCases = [
  { name: "3x3 solved", eventId: "333", scramble: "", kind: "3x3" },
  { name: "3x3 short", eventId: "333", scramble: "R U R' U'", kind: "3x3" },
  { name: "3x3 short 2", eventId: "333", scramble: "F R U R' U' F'", kind: "3x3" },
];

const defaultOptions = {
  include2x2: false,
  maxDepth: 14,
  randomCount: 0,
  randomLength: 6,
};

let solve2x2ScrambleFn = null;

function printHelp() {
  console.log(`Usage: node tools/solver-smoke.mjs [options]

Options:
  --random-count <n>   Add <n> random 3x3 smoke cases (default: 0)
  --random-length <n>  Random scramble length for generated cases (default: 6)
  --max-depth <n>      Max search depth passed to the 3x3 solver (default: 14)
  --include-2x2        Also run optional 2x2 smoke cases
  --help               Show this message`);
}

function parsePositiveInteger(name, value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = { ...defaultOptions };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--include-2x2") {
      options.include2x2 = true;
      continue;
    }
    if (arg === "--random-count" || arg === "--random-length" || arg === "--max-depth") {
      const next = argv[i + 1];
      if (typeof next !== "string") {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      if (arg === "--random-count") {
        options.randomCount = parsePositiveInteger(arg, next);
      } else if (arg === "--random-length") {
        options.randomLength = parsePositiveInteger(arg, next);
      } else {
        options.maxDepth = parsePositiveInteger(arg, next);
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function normalizeSolution(solution) {
  if (Array.isArray(solution)) return solution.filter(Boolean);
  if (typeof solution === "string") {
    return solution
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }
  return [];
}

function randomMove(moves) {
  return moves[Math.floor(Math.random() * moves.length)];
}

function createRandomScramble(moves, length) {
  if (length === 0) return "";

  const scramble = [];
  let lastFace = "";
  for (let i = 0; i < length; i++) {
    let move = randomMove(moves);
    while (move[0] === lastFace) {
      move = randomMove(moves);
    }
    scramble.push(move);
    lastFace = move[0];
  }
  return scramble.join(" ");
}

function buildCases(options) {
  const cases = [...fixedCases];

  for (let i = 0; i < options.randomCount; i++) {
    cases.push({
      name: `3x3 random ${i + 1}`,
      eventId: "333",
      scramble: createRandomScramble(THREE_BY_THREE_MOVES, options.randomLength),
      kind: "3x3",
    });
  }

  if (options.include2x2) {
    cases.push({ name: "2x2 solved", eventId: "222", scramble: "", kind: "2x2" });
    cases.push({ name: "2x2 short", eventId: "222", scramble: "R U R' U'", kind: "2x2" });

    for (let i = 0; i < options.randomCount; i++) {
      cases.push({
        name: `2x2 random ${i + 1}`,
        eventId: "222",
        scramble: createRandomScramble(TWO_BY_TWO_MOVES, options.randomLength),
        kind: "2x2",
      });
    }
  }

  return cases;
}

async function applySolution(state, solution) {
  let current = state;
  for (const move of normalizeSolution(solution)) {
    current = current.applyMove(move);
  }
  return current;
}

async function get2x2Solver() {
  if (!solve2x2ScrambleFn) {
    const module = await import("../solver/solver2x2.js");
    solve2x2ScrambleFn = module.solve2x2Scramble;
  }
  return solve2x2ScrambleFn;
}

async function solveCase(testCase, options) {
  if (testCase.kind === "2x2") {
    const solve2x2Scramble = await get2x2Solver();
    return await solve2x2Scramble(testCase.scramble);
  }
  return await solveScramble(testCase.scramble, {
    eventId: testCase.eventId,
    maxDepth: options.maxDepth,
  });
}

async function verifyCase(testCase, options) {
  const startState = await SolverState.fromScramble(testCase.scramble, testCase.eventId);
  const startedAt = Date.now();
  let result;
  try {
    result = await solveCase(testCase, options);
  } catch (error) {
    if (testCase.kind === "2x2") {
      throw new Error(`${testCase.name}: 2x2 solver threw before verification (${error instanceof Error ? error.message : String(error)})`);
    }
    throw error;
  }

  if (!result) {
    throw new Error(`${testCase.name}: solver returned no result`);
  }

  const endState = await applySolution(startState, result.solution);
  const solved = await endState.isSolved();
  if (!solved) {
    throw new Error(`${testCase.name}: solution did not solve the scramble`);
  }

  const solutionMoves = normalizeSolution(result.solution).length;
  const elapsedMs = Date.now() - startedAt;
  console.log(`${testCase.name}: ok (${solutionMoves} moves, ${elapsedMs}ms)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const cases = buildCases(options);
  console.log(
    `Running ${cases.length} smoke checks (randomCount=${options.randomCount}, randomLength=${options.randomLength}, include2x2=${options.include2x2}, maxDepth=${options.maxDepth}).`,
  );

  for (const testCase of cases) {
    await verifyCase(testCase, options);
  }

  console.log(`Passed ${cases.length} solver smoke checks.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
