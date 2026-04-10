import { getDefaultPattern } from './solver/context.js';
const p = await getDefaultPattern('333');
console.log('ok', !!p?.patternData);
