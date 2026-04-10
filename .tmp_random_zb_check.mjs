import { getDefaultPattern } from './solver/context.js';
import { solve3x3StrictCfopFromPattern } from './solver/cfop3x3.js';
const MOVES = ['U','U2','U\'', 'D','D2','D\'', 'L','L2','L\'', 'R','R2','R\'', 'F','F2','F\'', 'B','B2','B\''];
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
const trials = 100;
let failures = 0;
let totalMoves = 0;
let totalTimeMs = 0;
let totalNodes = 0;
let successful = 0;
for (let i = 1; i <= trials; i++) {
  const scramble = randomScramble(25);
  const input = pattern.applyAlg(scramble);
  const start = Date.now();
  const result = await solve3x3StrictCfopFromPattern(input, { crossColor: 'D', mode: 'zb' });
  const elapsed = Date.now() - start;
  if (result.ok) {
    successful += 1;
    totalMoves += result.moveCount || 0;
    totalTimeMs += elapsed;
    totalNodes += result.nodes || 0;
  } else {
    failures += 1;
  }
  console.log(
    `${i}: ok=${result.ok} reason=${result.reason || 'OK'} moves=${result.moveCount || '-'} nodes=${result.nodes || 0} timeMs=${elapsed}`,
  );
}
const avgMoves = successful ? totalMoves / successful : 0;
const avgTimeMs = successful ? totalTimeMs / successful : 0;
const avgNodes = successful ? totalNodes / successful : 0;
console.log('---');
console.log(`trials=${trials} successful=${successful} failures=${failures}`);
console.log(`avgMoves=${avgMoves.toFixed(2)} avgTimeMs=${avgTimeMs.toFixed(2)} avgNodes=${avgNodes.toFixed(0)}`);
