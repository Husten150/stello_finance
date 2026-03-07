import { FastifyPluginAsync } from "fastify";
import { PrismaClient } from "@prisma/client";
import { StakingEngine } from "../../staking-engine/index.js";

export const statsRoutes: FastifyPluginAsync<{
  prisma: PrismaClient;
  stakingEngine: StakingEngine;
}> = async (fastify, opts) => {
  const { prisma, stakingEngine } = opts;

  /**
   * GET /protocol-stats
   * Returns protocol metrics matching the frontend ProtocolStats interface.
   */
  fastify.get("/protocol-stats", async () => {
    // Use Promise.allSettled so individual RPC failures don't break the whole response
    const [metricsResult, statsResult, validatorResult] = await Promise.allSettled([
      prisma.protocolMetrics.findFirst({ orderBy: { updatedAt: "desc" } }),
      stakingEngine.getProtocolStats(),
      prisma.validator.count(),
    ]);

    const metrics = metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const validatorCount = validatorResult.status === "fulfilled" ? validatorResult.value : 0;

    // If full stats call failed, still try to get just the exchange rate
    let protocolStats: Awaited<ReturnType<typeof stakingEngine.getProtocolStats>> | null = null;
    if (statsResult.status === "fulfilled") {
      protocolStats = statsResult.value;
    }

    // Always try to get a real exchange rate even if getProtocolStats failed
    let exchangeRate = protocolStats?.exchangeRate ?? 1;
    if (!protocolStats) {
      try {
        exchangeRate = await stakingEngine.getExchangeRate();
      } catch {
        // last resort fallback
      }
    }

    const totalStakedXlm = protocolStats ? Number(protocolStats.totalStaked) / 1e7 : 0;
    const totalSxlmSupply = protocolStats ? Number(protocolStats.totalSupply) / 1e7 : 0;

    return {
      totalStaked: totalStakedXlm,
      totalSxlmSupply,
      exchangeRate,
      tvlUsd: metrics?.tvlUsd ?? 0,
      totalStakers: 0,
      totalValidators: validatorCount,
      xlmPrice: metrics?.tvlUsd && totalStakedXlm > 0
        ? metrics.tvlUsd / totalStakedXlm
        : 0.12,
      liquidityBuffer: protocolStats ? Number(protocolStats.liquidityBuffer) / 1e7 : 0,
      avgValidatorScore: metrics?.avgValidatorScore ?? 0,
      treasuryBalance: protocolStats ? Number(protocolStats.treasuryBalance) / 1e7 : 0,
      isPaused: protocolStats?.isPaused ?? false,
      protocolFeePct: protocolStats ? protocolStats.protocolFeeBps / 100 : 10,
    };
  });
};
