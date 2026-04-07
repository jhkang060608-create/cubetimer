import { expose } from "comlink";
import {
  experimentalSolve2x2x2,
  experimentalSolve3x3x3IgnoringCenters,
} from "cubing/search";

/**
 * Solver worker that runs cube solving algorithms in a background thread.
 * Exposes ping() and solve() methods via Comlink.
 */
const solverAPI = {
  /**
   * Ping method to verify worker is initialized and warm up the solver.
   * @returns {Promise<string>} "pong"
   */
  async ping() {
    return "pong";
  },

  /**
   * Solve a cube scramble.
   * @param {string|Object} scramble - The scramble string or object with scramble property
   * @param {string} eventId - Event ID ("222" or "333")
   * @param {Function} onProgress - Progress callback for 3x3x3 solving (proxied via Comlink)
   * @param {string} crossColor - Cross color for 3x3x3 solving (default: "D")
   * @param {string} solverMode - Solver mode: "strict" or "fast" (default: "strict")
   * @param {string} f2lMethod - F2L method: "legacy" or other (default: "legacy")
   * @returns {Promise<Object>} Solution object with ok, solution, moveCount, nodes, etc.
   */
  async solve(scramble, eventId, onProgress, crossColor, solverMode, f2lMethod) {
    try {
      // Handle object parameter (used in fallback ping during initialization)
      if (typeof scramble === "object" && scramble !== null) {
        const params = scramble;
        scramble = params.scramble || "";
        eventId = params.eventId || "222";
        onProgress = params.onProgress;
        crossColor = params.crossColor;
        solverMode = params.solverMode;
        f2lMethod = params.f2lMethod;
      }

      const scrambleStr = String(scramble || "").trim();

      if (eventId === "222") {
        // Solve 2x2x2
        const result = await experimentalSolve2x2x2(scrambleStr);
        return {
          ok: true,
          solution: result.alg?.toString() || "",
          moveCount: result.alg?.experimentalNumChildAlgNodes() || 0,
          nodes: result.nodes || 0,
        };
      } else if (eventId === "333") {
        // Solve 3x3x3
        const options = {
          crossColor: crossColor || "D",
        };

        // Add progress callback if provided
        if (onProgress && typeof onProgress === "function") {
          options.experimentalProgressCallback = onProgress;
        }

        // Handle solver mode
        if (solverMode === "fast") {
          options.generatorSearchOptions = { pruningTableSize: 1_000_000 };
        }

        // Handle F2L method
        if (f2lMethod !== "legacy") {
          options.experimentalStageOptions = { f2l: "eoline-zz-pseudo-CFOP" };
        }

        const result = await experimentalSolve3x3x3IgnoringCenters(scrambleStr, options);

        // Extract stages if available
        const stages = [];
        if (result.stages && Array.isArray(result.stages)) {
          for (const stage of result.stages) {
            stages.push({
              name: stage.name || "",
              solution: stage.alg?.toString() || "",
            });
          }
        }

        return {
          ok: true,
          solution: result.alg?.toString() || "",
          solutionDisplay: result.experimentalSolutionDisplay || "",
          moveCount: result.alg?.experimentalNumChildAlgNodes() || 0,
          nodes: result.nodes || 0,
          stages: stages.length > 0 ? stages : undefined,
        };
      } else {
        return {
          ok: false,
          error: `Unsupported event: ${eventId}`,
        };
      }
    } catch (error) {
      console.error("Solver error:", error);
      return {
        ok: false,
        error: error?.message || "Unknown solver error",
      };
    }
  },
};

expose(solverAPI);
