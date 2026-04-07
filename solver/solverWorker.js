import * as Comlink from "../vendor/comlink/index.js";
import { cube2x2x2, cube3x3x3 } from "../vendor/cubing/puzzles/index.js";
import { experimentalSolve2x2x2, experimentalSolve3x3x3IgnoringCenters } from "../vendor/cubing/search/index.js";

function normalizeSolveArgs(scrambleOrRequest, eventId, onProgress) {
  if (scrambleOrRequest && typeof scrambleOrRequest === "object") {
    return {
      scramble: typeof scrambleOrRequest.scramble === "string" ? scrambleOrRequest.scramble : "",
      eventId: typeof scrambleOrRequest.eventId === "string" ? scrambleOrRequest.eventId : "333",
      onProgress:
        typeof scrambleOrRequest.onProgress === "function" ? scrambleOrRequest.onProgress : onProgress,
    };
  }
  return {
    scramble: typeof scrambleOrRequest === "string" ? scrambleOrRequest : "",
    eventId: typeof eventId === "string" ? eventId : "333",
    onProgress: typeof onProgress === "function" ? onProgress : undefined,
  };
}

async function emitProgress(onProgress, progress) {
  if (typeof onProgress !== "function") return;
  try {
    await onProgress(progress);
  } catch (progressError) {
    console.debug("solver progress callback failed", progressError);
  }
}

function countMoves(solutionText) {
  return solutionText ? solutionText.split(/\s+/).filter(Boolean).length : 0;
}

async function solve(scrambleOrRequest, eventId, onProgress) {
  const args = normalizeSolveArgs(scrambleOrRequest, eventId, onProgress);
  const scramble = args.scramble.trim();
  if (!scramble) {
    return { ok: false, reason: "스크램블이 없습니다." };
  }

  try {
    if (args.eventId === "222") {
      await emitProgress(args.onProgress, {
        type: "stage_start",
        stageIndex: 0,
        totalStages: 1,
        stageName: "2x2 Search",
      });
      const kpuzzle = await cube2x2x2.kpuzzle();
      const pattern = kpuzzle.defaultPattern().applyAlg(scramble);
      const solution = await experimentalSolve2x2x2(pattern);
      const solutionText = solution.toString().trim();
      const moveCount = countMoves(solutionText);
      await emitProgress(args.onProgress, {
        type: "stage_done",
        stageIndex: 0,
        totalStages: 1,
        stageName: "2x2 Search",
        moveCount,
      });
      return {
        ok: true,
        solution: solutionText,
        moveCount,
        source: "CUBING_SEARCH",
      };
    }

    if (args.eventId === "333") {
      await emitProgress(args.onProgress, {
        type: "stage_start",
        stageIndex: 0,
        totalStages: 1,
        stageName: "3x3 Search",
      });
      const kpuzzle = await cube3x3x3.kpuzzle();
      const pattern = kpuzzle.defaultPattern().applyAlg(scramble);
      const solution = await experimentalSolve3x3x3IgnoringCenters(pattern);
      const solutionText = solution.toString().trim();
      const moveCount = countMoves(solutionText);
      await emitProgress(args.onProgress, {
        type: "stage_done",
        stageIndex: 0,
        totalStages: 1,
        stageName: "3x3 Search",
        moveCount,
      });
      return {
        ok: true,
        solution: solutionText,
        moveCount,
        source: "CUBING_SEARCH",
      };
    }

    return { ok: false, reason: "현재는 2x2, 3x3에서만 solver를 지원합니다." };
  } catch (error) {
    return { ok: false, reason: error?.message || "solver 실행 중 오류가 발생했습니다." };
  }
}

async function ping() {
  return "pong";
}

Comlink.expose({
  ping,
  solve,
});
