import { expose } from "comlink";
import { experimentalSolve2x2x2, experimentalSolve3x3x3IgnoringCenters } from "cubing/search";
import { Alg } from "cubing/alg";

/**
 * Solver Worker for CubeTimer
 * Provides cube solving functionality using cubing.js search algorithms
 */

const api = {
  /**
   * Ping function to check if worker is ready
   */
  async ping() {
    return "pong";
  },

  /**
   * Solve a cube scramble
   * @param {string} scramble - The scramble algorithm
   * @param {string} eventId - Event ID (222, 333, etc.)
   * @param {Function} onProgress - Progress callback (for 333 only)
   * @param {string} crossColor - Cross color for 333 (D, U, F, B, L, R)
   * @param {string} solverMode - Solver mode (strict, relaxed, etc.)
   * @param {string} f2lMethod - F2L method (legacy, modern, etc.)
   * @returns {Object} Solution result
   */
  async solve(scramble, eventId, onProgress, crossColor, solverMode, f2lMethod) {
    try {
      if (!scramble || typeof scramble !== "string") {
        return {
          ok: false,
          reason: "Invalid scramble",
        };
      }

      // Parse scramble into Alg object
      let scrambleAlg;
      try {
        scrambleAlg = Alg.fromString(scramble);
      } catch (error) {
        return {
          ok: false,
          reason: `스크램블 파싱 실패: ${error.message}`,
        };
      }

      if (eventId === "222") {
        // 2x2x2 solving
        const result = await experimentalSolve2x2x2(scrambleAlg);

        if (!result) {
          return {
            ok: false,
            reason: "2x2 해를 찾지 못했습니다.",
          };
        }

        const solutionString = result.toString();
        const moveCount = solutionString.split(/\s+/).filter(Boolean).length;

        return {
          ok: true,
          solution: solutionString,
          solutionDisplay: solutionString,
          moveCount: moveCount,
          nodes: null,
        };
      } else if (eventId === "333") {
        // 3x3x3 solving with progress tracking
        const stages = [];
        let totalMoveCount = 0;
        const stageNames = ["Cross", "F2L", "OLL", "PLL"];

        // Notify progress callback about stages
        const notifyProgress = (type, stageIndex, stageName, moveCount) => {
          if (onProgress && typeof onProgress === "function") {
            try {
              onProgress({
                type: type,
                stageIndex: stageIndex,
                stageName: stageName,
                totalStages: 4,
                moveCount: moveCount || 0,
              });
            } catch (error) {
              console.error("Progress callback error:", error);
            }
          }
        };

        // Stage 1: Cross
        notifyProgress("stage_start", 0, "Cross", 0);

        // For now, use the experimental solve function
        // This is a simplified implementation - a full CFOP solver would need
        // separate implementations for each stage
        const result = await experimentalSolve3x3x3IgnoringCenters(scrambleAlg);

        if (!result) {
          notifyProgress("stage_fail", 0, "Cross", 0);
          return {
            ok: false,
            reason: "3x3 해를 찾지 못했습니다.",
          };
        }

        const solutionString = result.toString();
        const moveCount = solutionString.split(/\s+/).filter(Boolean).length;

        // For a basic implementation, we'll report it as a single-stage solution
        // A full CFOP implementation would break this into Cross, F2L pairs, OLL, and PLL
        stages.push({
          name: "Solution",
          solution: solutionString,
          moveCount: moveCount,
        });

        notifyProgress("stage_done", 0, "Solution", moveCount);

        return {
          ok: true,
          solution: solutionString,
          solutionDisplay: solutionString,
          moveCount: moveCount,
          stages: stages,
          nodes: null,
        };
      } else {
        return {
          ok: false,
          reason: `지원하지 않는 종목: ${eventId}`,
        };
      }
    } catch (error) {
      console.error("Solver error:", error);
      return {
        ok: false,
        reason: `오류: ${error.message || "알 수 없는 오류"}`,
      };
    }
  },
};

// Expose the API using Comlink
expose(api);
