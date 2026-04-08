function safeOrbit(pattern, orbitName) {
  const orbit = pattern?.patternData?.[orbitName];
  if (!orbit) {
    return { pieces: [], orientation: [] };
  }
  return {
    pieces: Array.isArray(orbit.pieces) ? orbit.pieces.slice() : [],
    orientation: Array.isArray(orbit.orientation) ? orbit.orientation.slice() : [],
  };
}

export function parsePatternToCoords3x3(pattern) {
  return {
    corners: safeOrbit(pattern, "CORNERS"),
    edges: safeOrbit(pattern, "EDGES"),
    centers: safeOrbit(pattern, "CENTERS"),
  };
}

