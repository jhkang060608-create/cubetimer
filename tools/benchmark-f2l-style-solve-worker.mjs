import { performance } from "perf_hooks";
import { parentPort, workerData } from "worker_threads";
import { getDefaultPattern } from "../solver/context.js";
import { solve3x3StrictCfopFromPattern } from "../solver/cfop3x3.js";
import { getF2LTransitionProfileForSolver } from "../solver/f2lTransitionProfiles.js";

const STRICT_BENCHMARK_RETRY_OPTIONS = Object.freeze([
  Object.freeze({
    // Match the app's first strict retry budget.
    f2lFormulaMaxSteps: 16,
    f2lFormulaBeamWidth: 12,
    f2lFormulaExpansionLimit: 20,
    f2lFormulaMaxAttempts: 600000,
    f2lSearchMaxDepth: 14,
    f2lNodeLimit: 600000,
  }),
  Object.freeze({
    // Match the app's second strict retry budget.
    f2lFormulaMaxSteps: 18,
    f2lFormulaBeamWidth: 16,
    f2lFormulaExpansionLimit: 28,
    f2lFormulaMaxAttempts: 1200000,
    f2lSearchMaxDepth: 16,
    f2lNodeLimit: 1500000,
  }),
]);

function toNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function send(message) {
  if (parentPort) {
    parentPort.postMessage(message);
  }
}

function sendResult(taskId, payload) {
  send({ type: "result", taskId, ...payload });
}

function splitMoveTokens(text) {
  return String(text || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseMoveToken(token) {
  const match = /^([A-Za-z]+)(2'?|')?$/.exec(token);
  if (!match) return null;
  return {
    face: match[1],
  };
}

function isCubeRotationFace(face) {
  return face === "x" || face === "y" || face === "z" || face === "X" || face === "Y" || face === "Z";
}

function isWideTurnFace(face) {
  if (!face) return false;
  if (face.endsWith("w") || face.endsWith("W")) return true;
  return face === "u" || face === "r" || face === "f" || face === "d" || face === "l" || face === "b";
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function computeStyleMetrics(solutionText, stages, mode) {
  const moves = splitMoveTokens(solutionText);
  let rotationCount = 0;
  let aufCount = 0;
  let wideTurnCount = 0;
  for (let i = 0; i < moves.length; i++) {
    const parsed = parseMoveToken(moves[i]);
    if (!parsed) continue;
    const face = parsed.face;
    if (isCubeRotationFace(face)) {
      rotationCount += 1;
      continue;
    }
    if (face === "U") aufCount += 1;
    if (isWideTurnFace(face)) wideTurnCount += 1;
  }

  const f2lSegmentLens = [];
  const stageList = Array.isArray(stages) ? stages : [];
  let hasZbStage = false;
  for (let i = 0; i < stageList.length; i++) {
    const stageName = String(stageList[i]?.name || "");
    const stageLower = stageName.toLowerCase();
    if (stageLower.includes("zbls") || stageLower.includes("zbll")) {
      hasZbStage = true;
    }
    if (!stageLower.includes("f2l")) continue;
    const stageMoves = splitMoveTokens(stageList[i]?.solution || "");
    if (stageMoves.length > 0) f2lSegmentLens.push(stageMoves.length);
  }

  const llApproach = hasZbStage || mode === "zb" ? "ZB" : "CFOP";
  return {
    moveCount: moves.length,
    rotationRate: moves.length > 0 ? rotationCount / moves.length : null,
    aufRate: moves.length > 0 ? aufCount / moves.length : null,
    wideTurnRate: moves.length > 0 ? wideTurnCount / moves.length : null,
    avgF2LSegmentLen: average(f2lSegmentLens),
    zbUsageRate: llApproach === "ZB" ? 1 : 0,
    llApproach,
  };
}

async function solveTask(task) {
  const started = performance.now();
  const scramble = String(task?.scramble || "").trim();
  const timeoutMs = Math.max(1000, Number(task?.timeoutMs) || 5000);
  const mode = String(task?.mode || "strict").trim() || "strict";
  const crossColor = String(task?.crossColor || "D").trim() || "D";
  const styleProfile = task?.styleProfile;
  const transitionProfileSolver = String(task?.transitionProfileSolver || "").trim();
  const f2lTransitionProfile = await getF2LTransitionProfileForSolver(transitionProfileSolver);

  if (!scramble) {
    return {
      ok: false,
      reason: "NO_SCRAMBLE",
      moveCount: null,
      nodes: null,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
    };
  }

  const solvedPattern = await getDefaultPattern("333");
  const pattern = solvedPattern.applyAlg(scramble);
  const baseSolveOptions = {
    mode,
    crossColor,
    scramble,
    f2lStyleProfile: styleProfile,
    styleProfile,
    f2lTransitionProfile,
  };

  const runSolve = (extraOptions = {}) =>
    solve3x3StrictCfopFromPattern(pattern, {
      ...baseSolveOptions,
      ...extraOptions,
    });

  const strictSolveOptions =
    mode === "strict"
      ? {
          ...STRICT_BENCHMARK_RETRY_OPTIONS[0],
          deadlineTs: 0,
        }
      : {
          deadlineTs: Date.now() + Math.max(250, timeoutMs - 100),
          allowRelaxedSearch: false,
        };

  const result = await runSolve(strictSolveOptions);

  const durationMs = Math.max(1, Math.round(performance.now() - started));
  if (!result?.ok) {
    return {
      ok: false,
      reason: String(result?.reason || "NO_SOLUTION"),
      stage: result?.stage || null,
      moveCount: null,
      nodes: toNullableNumber(result?.nodes),
      styleMetrics: null,
      durationMs,
    };
  }

  const solutionText =
    typeof result?.solution === "string"
      ? result.solution
      : Array.isArray(result?.stages)
        ? result.stages
            .map((stage) => String(stage?.solution || "").trim())
            .filter(Boolean)
            .join(" ")
            .trim()
        : "";
  const styleMetrics = computeStyleMetrics(solutionText, result?.stages, mode);

  return {
    ok: true,
    reason: null,
    moveCount: toNullableNumber(result?.moveCount),
    nodes: toNullableNumber(result?.nodes),
    stage: null,
    styleMetrics,
    durationMs,
  };
}

async function main() {
  if (workerData && workerData.__poolMode) {
    if (parentPort) {
      parentPort.on("message", async (message) => {
        if (!message || message.type !== "solve") return;
        try {
          const payload = await solveTask(message.task);
          sendResult(message.taskId, payload);
        } catch (error) {
          sendResult(message.taskId, {
            ok: false,
            reason: String(error?.message || error),
            stage: null,
            moveCount: null,
            nodes: null,
            styleMetrics: null,
            durationMs: 1,
          });
        }
      });
      send({ type: "ready" });
    }
    return;
  }

  const task = workerData || {};
  const taskId = Number.isFinite(Number(task?.taskId)) ? Number(task.taskId) : 0;
  try {
    const payload = await solveTask(task);
    sendResult(taskId, payload);
  } catch (error) {
    sendResult(taskId, {
      ok: false,
      reason: String(error?.message || error),
      stage: null,
      moveCount: null,
      nodes: null,
      styleMetrics: null,
      durationMs: 1,
    });
  }
}

main();
