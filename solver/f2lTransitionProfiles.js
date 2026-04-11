const DEFAULT_F2L_TRANSITION_DATA_URL = new URL(
  "../vendor-data/reco/reco-3x3-f2l-transition.json",
  import.meta.url,
);

let cachedTransitionDataKey = "";
let cachedTransitionDataPromise = null;
let cachedTransitionData = null;
let cachedTransitionIndexKey = "";
let cachedTransitionIndexPromise = null;
let cachedTransitionIndex = null;

function isNodeEnvironment() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function isUrlLike(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(value || ""));
}

function resolveInputLocation(inputPath = DEFAULT_F2L_TRANSITION_DATA_URL) {
  if (!inputPath) return DEFAULT_F2L_TRANSITION_DATA_URL;
  if (inputPath instanceof URL) return inputPath;
  const raw = String(inputPath).trim();
  if (!raw) return DEFAULT_F2L_TRANSITION_DATA_URL;
  if (isUrlLike(raw)) {
    try {
      return new URL(raw);
    } catch (_) {
      return raw;
    }
  }
  if (!isNodeEnvironment()) {
    return new URL(raw, import.meta.url);
  }
  return raw;
}

async function readJsonFromLocation(location) {
  if (!isNodeEnvironment()) {
    const response = await fetch(location, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  }

  const { readFile } = await import("fs/promises");
  return JSON.parse(await readFile(location, "utf8"));
}

async function loadTransitionJson(inputPath = DEFAULT_F2L_TRANSITION_DATA_URL) {
  const location = resolveInputLocation(inputPath);
  const cacheKey = location instanceof URL ? location.href : String(location);
  if (cachedTransitionData && cachedTransitionDataKey === cacheKey) {
    return cachedTransitionData;
  }
  if (cachedTransitionDataPromise && cachedTransitionDataKey === cacheKey) {
    return await cachedTransitionDataPromise;
  }

  cachedTransitionDataKey = cacheKey;
  cachedTransitionDataPromise = (async () => {
    try {
      const parsed = await readJsonFromLocation(location);
      cachedTransitionData = parsed;
      return parsed;
    } catch (error) {
      cachedTransitionData = null;
      throw error;
    }
  })();
  try {
    return await cachedTransitionDataPromise;
  } finally {
    cachedTransitionDataPromise = null;
  }
}

function buildTransitionIndexFromData(parsed, resolvedLocation) {
  if (!parsed || typeof parsed !== "object") return null;

  const globalTransitionProfile =
    parsed.globalTransitionProfile && typeof parsed.globalTransitionProfile === "object"
      ? parsed.globalTransitionProfile
      : parsed.transitionProfile && typeof parsed.transitionProfile === "object"
        ? parsed.transitionProfile
        : null;
  const playerProfiles = Array.isArray(parsed.playerTransitionProfiles)
    ? parsed.playerTransitionProfiles
    : Array.isArray(parsed.players)
      ? parsed.players
      : [];

  const playerTransitionProfileMap = new Map();
  for (let i = 0; i < playerProfiles.length; i++) {
    const profile = playerProfiles[i];
    if (!profile || typeof profile !== "object") continue;
    const solver = String(profile.solver || "").trim();
    if (!solver) continue;
    playerTransitionProfileMap.set(solver, profile);
  }

  return {
    sourcePath: resolvedLocation instanceof URL ? resolvedLocation.href : String(resolvedLocation || ""),
    data: parsed,
    globalTransitionProfile,
    playerTransitionProfileMap,
  };
}

async function buildTransitionIndex(inputPath = DEFAULT_F2L_TRANSITION_DATA_URL) {
  const location = resolveInputLocation(inputPath);
  const cacheKey = location instanceof URL ? location.href : String(location);
  if (cachedTransitionIndex && cachedTransitionIndexKey === cacheKey) {
    return cachedTransitionIndex;
  }
  if (cachedTransitionIndexPromise && cachedTransitionIndexKey === cacheKey) {
    return await cachedTransitionIndexPromise;
  }

  cachedTransitionIndexKey = cacheKey;
  cachedTransitionIndexPromise = (async () => {
    const parsed = await loadTransitionJson(location);
    const index = buildTransitionIndexFromData(parsed, location);
    cachedTransitionIndex = index;
    return index;
  })();
  try {
    return await cachedTransitionIndexPromise;
  } finally {
    cachedTransitionIndexPromise = null;
  }
}

export async function getF2LTransitionData(inputPath = DEFAULT_F2L_TRANSITION_DATA_URL) {
  return await loadTransitionJson(inputPath);
}

export async function getGlobalF2LTransitionProfile(inputPath = DEFAULT_F2L_TRANSITION_DATA_URL) {
  const index = await buildTransitionIndex(inputPath);
  return index ? index.globalTransitionProfile : null;
}

export async function getF2LTransitionProfileForSolver(
  solverName,
  inputPath = DEFAULT_F2L_TRANSITION_DATA_URL,
) {
  const solver = String(solverName || "").trim();
  if (!solver) {
    return null;
  }
  const index = await buildTransitionIndex(inputPath);
  if (!index) return null;
  const solverProfile = index.playerTransitionProfileMap.get(solver) || null;
  if (!solverProfile) {
    return index.globalTransitionProfile || null;
  }
  if (!index.globalTransitionProfile) {
    return solverProfile;
  }
  return {
    profile: solverProfile,
    fallbackProfile: index.globalTransitionProfile,
  };
}
