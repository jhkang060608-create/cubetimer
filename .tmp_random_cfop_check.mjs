import { getDefaultPattern } from './solver/context.js';
import { solve3x3StrictCfopFromPattern } from './solver/cfop3x3.js';
const MOVES = ['U','U2','U\'', 'D','D2','D\'', 'L','L2','L\'', 'R','R2','R\'', 'F','F2','F\'', 'B','B2','B\''];
const f2lMethod = String(process.argv[2] || 'fast');
const trials = Math.max(1, Number(process.argv[3] || 50) | 0);

function randomScramble(length = 25) {
  const out = [];
  let lastFace = null;
  let lastMove = null;
  for (let i = 0; i < length; i++) {
    let move;
    do {
      move = MOVES[Math.floor(Math.random() * MOVES.length)];
    } while (move[0] === lastFace || (lastMove && move[0] === lastMove[0] && move.length === 1 && lastMove.length === 1));
    out.push(move);
    lastFace = move[0];
    lastMove = move;
  }
  return out.join(' ');
}
const pattern = await getDefaultPattern('333');
let failures = 0;
let solved = 0;
let totalMoves = 0;
let totalNodes = 0;
for (let i = 1; i <= trials; i++) {
  const scramble = randomScramble(25);
  const input = pattern.applyAlg(scramble);
  const result = await solve3x3StrictCfopFromPattern(input, {
    crossColor: 'D',
    mode: 'strict',
    f2lMethod,
    deadlineTs: Date.now() + 45000,
  });
  console.log(`${i}: ${scramble}`);
  console.log(`   ok=${result.ok} reason=${result.reason || 'OK'} moves=${result.moveCount || '-'} nodes=${result.nodes || 0}`);
  if (!result.ok) {
    failures += 1;
    console.error(`   FAILURE stage=${result.stage || '-'} reason=${result.reason || '-'}`);
    continue;
  }
  solved += 1;
  totalMoves += Number(result.moveCount || 0);
  totalNodes += Number(result.nodes || 0);
}
const avgMoves = solved > 0 ? (totalMoves / solved).toFixed(2) : '-';
const avgNodes = solved > 0 ? Math.round(totalNodes / solved) : '-';
console.log('finished', { trials, f2lMethod, solved, failures, avgMoves, avgNodes });
