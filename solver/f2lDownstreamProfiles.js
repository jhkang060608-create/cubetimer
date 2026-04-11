const DEFAULT_F2L_DOWNSTREAM_DATA_URL = new URL(
  "../vendor-data/reco/reco-3x3-f2l-ll-prediction.json",
  import.meta.url,
);

let cachedDownstreamDataKey = "";
let cachedDownstreamDataPromise = null;
let cachedDownstreamData = null;
let cachedDownstreamIndexKey = "";
let cachedDownstreamIndexPromise = null;
let cachedDownstreamIndex = null;

function isNodeEnvironment() {
  return typeof process !== "undefined" && !!process.versions?.node;
}

function isUrlLike(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(String(value || ""));
}

function resolveInputLocation(inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL) {
  if (!inputPath) return DEFAULT_F2L_DOWNSTREAM_DATA_URL;
  if (inputPath instanceof URL) return inputPath;
  const raw = String(inputPath).trim();
  if (!raw) return DEFAULT_F2L_DOWNSTREAM_DATA_URL;
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

async function loadDownstreamJson(inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL) {
  const location = resolveInputLocation(inputPath);
  const cacheKey = location instanceof URL ? location.href : String(location);
  if (cachedDownstreamData && cachedDownstreamDataKey === cacheKey) {
    return cachedDownstreamData;
  }
  if (cachedDownstreamDataPromise && cachedDownstreamDataKey === cacheKey) {
    return await cachedDownstreamDataPromise;
  }

  cachedDownstreamDataKey = cacheKey;
  cachedDownstreamDataPromise = (async () => {
    try {
      const parsed = await readJsonFromLocation(location);
      cachedDownstreamData = parsed;
      return parsed;
    } catch (error) {
      cachedDownstreamData = null;
      throw error;
    }
  })();
  try {
    return await cachedDownstreamDataPromise;
  } finally {
    cachedDownstreamDataPromise = null;
  }
}

function buildDownstreamIndexFromData(parsed, resolvedLocation) {
  if (!parsed || typeof parsed !== "object") return null;

  const globalDownstreamProfile =
    parsed.globalDownstreamProfile && typeof parsed.globalDownstreamProfile === "object"
      ? parsed.globalDownstreamProfile
      : parsed.downstreamProfile && typeof parsed.downstreamProfile === "object"
        ? parsed.downstreamProfile
        : null;
  const playerProfiles = Array.isArray(parsed.playerDownstreamProfiles)
    ? parsed.playerDownstreamProfiles
    : Array.isArray(parsed.players)
      ? parsed.players
      : [];

  const playerDownstreamProfileMap = new Map();
  for (let i = 0; i < playerProfiles.length; i++) {
    const profile = playerProfiles[i];
    if (!profile || typeof profile !== "object") continue;
    const solver = String(profile.solver || "").trim();
    if (!solver) continue;
    playerDownstreamProfileMap.set(solver, profile);
  }

  return {
    sourcePath: resolvedLocation instanceof URL ? resolvedLocation.href : String(resolvedLocation || ""),
    data: parsed,
    globalDownstreamProfile,
    playerDownstreamProfileMap,
  };
}

async function buildDownstreamIndex(inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL) {
  const location = resolveInputLocation(inputPath);
  const cacheKey = location instanceof URL ? location.href : String(location);
  if (cachedDownstreamIndex && cachedDownstreamIndexKey === cacheKey) {
    return cachedDownstreamIndex;
  }
  if (cachedDownstreamIndexPromise && cachedDownstreamIndexKey === cacheKey) {
    return await cachedDownstreamIndexPromise;
  }

  cachedDownstreamIndexKey = cacheKey;
  cachedDownstreamIndexPromise = (async () => {
    const parsed = await loadDownstreamJson(location);
    const index = buildDownstreamIndexFromData(parsed, location);
    cachedDownstreamIndex = index;
    return index;
  })();
  try {
    return await cachedDownstreamIndexPromise;
  } finally {
    cachedDownstreamIndexPromise = null;
  }
}

export async function getF2LDownstreamData(inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL) {
  return await loadDownstreamJson(inputPath);
}

export async function getGlobalF2LDownstreamProfile(inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL) {
  const index = await buildDownstreamIndex(inputPath);
  return index ? index.globalDownstreamProfile : null;
}

export async function getF2LDownstreamProfileForSolver(
  solverName,
  inputPath = DEFAULT_F2L_DOWNSTREAM_DATA_URL,
) {
  const solver = String(solverName || "").trim();
  const index = await buildDownstreamIndex(inputPath);
  if (!index) return null;
  const globalProfile = index.globalDownstreamProfile || null;
  if (!solver) {
    return globalProfile;
  }

  const solverProfile = index.playerDownstreamProfileMap.get(solver) || null;
  if (!solverProfile) {
    return globalProfile;
  }
  if (!globalProfile) {
    return solverProfile;
  }
  return {
    profile: solverProfile,
    fallbackProfile: globalProfile,
  };
}
