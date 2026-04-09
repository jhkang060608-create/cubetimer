import { getDefaultPattern } from "./solver/context.js";
import { solve3x3StrictCfopFromPattern } from "./solver/cfop3x3.js";

const scramble = "U L D B' R F2 D' L D2 L2 D L2 D2 L R' D R F D R U2 L' R' L";
const solved = await getDefaultPattern("333");
const pattern = solved.applyAlg(scramble);
const t0 = Date.now();
const result = await solve3x3StrictCfopFromPattern(pattern, {
  mode: "roux",
  crossColor: "D",
  rouxOrientationSweep: false,
  rouxAllowCfopStageRecovery: false,
  sbDeepRetry: false,
  lseNodeLimit: 0,
  lseSecondaryNodeLimit: 0,
  lseSearchMaxDepth: 15,
  lseSecondarySearchMaxDepth: 15,
  lseMoveOrderingDepth: 12,
  lseBridgeAttemptLimit: 200000,
  lseBridgeFrontierLimit: 80,
  lseCompositeMaxDepth: 40,
  deadlineTs: Date.now() + 120000,
});
const t1 = Date.now();
console.log(JSON.stringify({ ok: !!result?.ok, reason: result?.reason || "", stage: result?.stage || "", moveCount: result?.moveCount ?? null, source: result?.source || "", ms: t1 - t0 }, null, 2));
