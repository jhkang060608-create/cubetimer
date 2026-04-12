const VALID_F2L_METHODS = new Set(["legacy", "balanced", "rotationless", "low-auf", "speed", "mixed"]);
const DEFAULT_F2L_METHOD = "legacy";
const MIXED_ACTIVATION_THRESHOLD = 0.45;

function clampRate01(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function normalizeMixedCfopSummaryRecord(profile) {
  if (!profile || typeof profile !== "object") return null;
  const solveCount = Number(profile.solveCount);
  const xcrossRate = Number(profile.xcrossRate);
  const xxcrossRate = Number(profile.xxcrossRate);
  const crossRate = Number(profile.crossRate);
  const firstStageXCrossRate = Number(profile.firstStageXCrossRate);
  const firstStageXXCrossRate = Number(profile.firstStageXXCrossRate ?? profile.firstStageXxCrossRate);
  const firstStageCrossRate = Number(profile.firstStageCrossRate);
  const zbllRate = Number(profile.zbllRate);
  const zblsRate = Number(profile.zblsRate);
  return {
    solveCount: Number.isFinite(solveCount) ? Math.max(0, Math.floor(solveCount)) : 0,
    xcrossRate: Number.isFinite(xcrossRate) ? xcrossRate : null,
    xxcrossRate: Number.isFinite(xxcrossRate) ? xxcrossRate : null,
    crossRate: Number.isFinite(crossRate) ? crossRate : null,
    firstStageXCrossRate: Number.isFinite(firstStageXCrossRate) ? firstStageXCrossRate : null,
    firstStageXXCrossRate: Number.isFinite(firstStageXXCrossRate) ? firstStageXXCrossRate : null,
    firstStageXxCrossRate: Number.isFinite(firstStageXXCrossRate) ? firstStageXXCrossRate : null,
    firstStageCrossRate: Number.isFinite(firstStageCrossRate) ? firstStageCrossRate : null,
    zbllRate: Number.isFinite(zbllRate) ? zbllRate : null,
    zblsRate: Number.isFinite(zblsRate) ? zblsRate : null,
  };
}

export function normalizeCaseBiasRecord(caseBias) {
  if (!caseBias || typeof caseBias !== "object") return null;
  const xcrossWeight = Number(caseBias.xcrossWeight);
  const xxcrossWeight = Number(caseBias.xxcrossWeight);
  const zbllWeight = Number(caseBias.zbllWeight);
  const zblsWeight = Number(caseBias.zblsWeight);
  if (
    !Number.isFinite(xcrossWeight) ||
    !Number.isFinite(xxcrossWeight) ||
    !Number.isFinite(zbllWeight) ||
    !Number.isFinite(zblsWeight)
  ) {
    return null;
  }
  return {
    xcrossWeight: Math.max(1, Math.min(12, Math.round(xcrossWeight))),
    xxcrossWeight: Math.max(1, Math.min(12, Math.round(xxcrossWeight))),
    zbllWeight: Math.max(1, Math.min(12, Math.round(zbllWeight))),
    zblsWeight: Math.max(1, Math.min(12, Math.round(zblsWeight))),
  };
}

export function formatCaseBiasSummary(caseBias) {
  if (!caseBias || typeof caseBias !== "object") return "";
  return `XC ${caseBias.xcrossWeight}, XXC ${caseBias.xxcrossWeight}, ZBLL ${caseBias.zbllWeight}, ZBLS ${caseBias.zblsWeight}`;
}

export function formatMixedCfopSummary(summary) {
  if (!summary || typeof summary !== "object") return "";
  const formatRatioPercent = (value) => {
    if (!Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(1)}%`;
  };
  return [
    `1st Cross ${formatRatioPercent(summary.firstStageCrossRate)}`,
    `1st XCross ${formatRatioPercent(summary.firstStageXCrossRate)}`,
    `XXCross ${formatRatioPercent(summary.xxcrossRate)}`,
    `ZBLL ${formatRatioPercent(summary.zbllRate)}`,
  ].join(", ");
}

export function estimateMixedActivationScore(profile, mixedProfile, mixedSummary, caseBias) {
  let score = 0;
  if (mixedProfile) score += 0.15;
  const styleSimilarity = clampRate01(profile?.styleSimilarity ?? mixedProfile?.styleSimilarity);
  if (styleSimilarity !== null) {
    score += styleSimilarity * 0.35;
    if (styleSimilarity >= 0.6) score += 0.05;
    if (styleSimilarity >= 0.8) score += 0.08;
  }
  if (mixedSummary) {
    const firstStageXCrossRate = Number(mixedSummary.firstStageXCrossRate);
    const xxcrossRate = Number(mixedSummary.xxcrossRate);
    const zbllRate = Number(mixedSummary.zbllRate);
    const zblsRate = Number(mixedSummary.zblsRate);

    if (firstStageXCrossRate >= 0.4) score += 0.15;
    else if (firstStageXCrossRate >= 0.25) score += 0.1;

    if (xxcrossRate >= 0.08) score += 0.12;
    else if (xxcrossRate >= 0.03) score += 0.05;

    if (zbllRate >= 0.2) score += 0.15;
    else if (zbllRate >= 0.08) score += 0.08;

    if (zblsRate >= 0.05) score += 0.05;
  }
  if (caseBias) {
    if (caseBias.xcrossWeight >= 6) score += 0.1;
    else if (caseBias.xcrossWeight >= 4) score += 0.05;
    if (caseBias.xxcrossWeight >= 2) score += 0.05;
    if (caseBias.zbllWeight >= 4) score += 0.12;
    else if (caseBias.zbllWeight >= 3) score += 0.08;
    if (caseBias.zblsWeight >= 2) score += 0.05;
  }
  if (profile?.mixedEligible === false) score -= 0.5;
  return Number(score.toFixed(6));
}

export function resolvePlayerRecommendedF2LMethod(profile) {
  if (!profile || typeof profile !== "object") return DEFAULT_F2L_METHOD;

  const recommendedRaw = String(profile.recommendedF2LMethod || "").trim().toLowerCase();
  const normalizedRecommended = VALID_F2L_METHODS.has(recommendedRaw) ? recommendedRaw : "";
  const forcePureCfop = profile.forcePureCfop === true;

  if (forcePureCfop) {
    return normalizedRecommended || DEFAULT_F2L_METHOD;
  }

  const mixedProfile =
    profile.mixedCfopStyleProfile ||
    profile.mixedStyleProfile ||
    profile.learnedStyleProfile ||
    profile.recommendedStyleProfile ||
    null;
  const mixedSummary = normalizeMixedCfopSummaryRecord(profile.mixedCfopSummary || profile.mixedCfopStats || profile.summary);
  const caseBias = normalizeCaseBiasRecord(profile.caseBias);
  if (mixedProfile || mixedSummary) {
    if (profile.mixedEligible === false) {
      return normalizedRecommended || DEFAULT_F2L_METHOD;
    }
    if (!caseBias) {
      return "mixed";
    }
    const score = estimateMixedActivationScore(profile, mixedProfile, mixedSummary, caseBias);
    if (score >= MIXED_ACTIVATION_THRESHOLD) {
      return "mixed";
    }
    return normalizedRecommended || DEFAULT_F2L_METHOD;
  }

  return normalizedRecommended || DEFAULT_F2L_METHOD;
}

export {
  DEFAULT_F2L_METHOD,
  MIXED_ACTIVATION_THRESHOLD,
  VALID_F2L_METHODS,
  clampRate01,
};
