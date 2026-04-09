import { getDefaultPattern } from "./solver/context.js";
import { solve3x3StrictCfopFromPattern } from "./solver/cfop3x3.js";

const MOVES = [
  "U", "U2", "U'",
  "R", "R2", "R'",
  "F", "F2", "F'",
  "D", "D2", "D'",
  "L", "L2", "L'",
  "B", "B2", "B'",
];

function randomScramble(length = 24) {
  const out = [];
  let lastFace = "";
  for (let i = 0; i < length; i++) {
    let mv = "";
    do {
      mv = MOVES[Math.floor(Math.random() * MOVES.length)];
    } while (mv[0] === lastFace);
    out.push(mv);
    lastFace = mv[0];
  }
  return out.join(" ");
}

const maxTrials = Math.max(1, Number(process.argv[2] || 20));
const solved = await getDefaultPattern("333");
let found = false;
for (let i = 1; i <= maxTrials; i++) {
  const scramble = randomScramble(24);
  const pattern = solved.applyAlg(scramble);
  const t0 = Date.now();
  const result = await solve3x3StrictCfopFromPattern(pattern, {
    mode: "roux",
    crossColor: "D",
    rouxOrientationSweep: false,
    rouxAllowCfopStageRecovery: false,
    sbDeepRetry: false,
    deadlineTs: Date.now() + 90000,
  });
  const dt = Date.now() - t0;
  const reason = result?.ok ? "OK" : String(result?.reason || "UNKNOWN");
  console.log(JSON.stringify({ i, reason, stage: result?.stage || "", ms: dt, scramble }));
  if (reason === "LSE_NOT_FOUND") {
    found = true;
    break;
  }
}
if (!found) {
  console.log(JSON.stringify({ done: true, message: "NO_LSE_NOT_FOUND_WITHIN_LIMIT", maxTrials }));
}
