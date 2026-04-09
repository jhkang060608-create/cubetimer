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

const trials = Math.max(1, Number(process.argv[2] || 12));
const solved = await getDefaultPattern("333");
const reasonCount = new Map();
let okCount = 0;
let lseNotFoundCount = 0;
let totalMs = 0;

for (let i = 1; i <= trials; i++) {
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
  totalMs += dt;

  const reason = result?.ok ? "OK" : String(result?.reason || "UNKNOWN");
  reasonCount.set(reason, (reasonCount.get(reason) || 0) + 1);
  if (reason === "LSE_NOT_FOUND") lseNotFoundCount += 1;
  if (result?.ok) okCount += 1;

  console.log(
    JSON.stringify({
      i,
      ok: !!result?.ok,
      reason,
      stage: result?.stage || "",
      moveCount: result?.moveCount ?? null,
      ms: dt,
    }),
  );
}

const reasons = Array.from(reasonCount.entries()).sort((a, b) => b[1] - a[1]);
console.log(
  JSON.stringify({
    trials,
    okCount,
    failCount: trials - okCount,
    lseNotFoundCount,
    avgMs: Math.round(totalMs / trials),
    reasons,
  }),
);
