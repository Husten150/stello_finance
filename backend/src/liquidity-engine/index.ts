// ============================================================
// Liquidity Engine — types, constants, and pure helper functions
// ============================================================

export const DEFAULT_SWAP_FEE_BPS = 30; // 0.30% swap fee
const STROOP = 10_000_000n; // 1e7 — Stellar asset precision

// ---- Types ----

export type DexTokenSymbol = "XLM" | "sXLM";

export interface PoolSnapshot {
  reserveXlmRaw: bigint;
  reserveSxlmRaw: bigint;
  totalLpSupplyRaw: bigint;
  feeBps: number;
  observedAt: Date;
}

export interface OracleObservation {
  observedAt: Date;
  spotPrice: number;
}

export interface OracleSnapshot {
  twapPrice: number;
  spotPrice: number;
  windowSeconds: number;
  observations: number;
  updatedAt: string;
}

export interface SwapQuote {
  tokenIn: DexTokenSymbol;
  tokenOut: DexTokenSymbol;
  amountInRaw: bigint;
  amountOutRaw: bigint;
  amountInDisplay: number;
  amountOutDisplay: number;
  priceImpactBps: number;
  minAmountOutRaw: bigint;
  feeBps: number;
}

export interface DexRoute {
  dex: string;
  tokenIn: DexTokenSymbol;
  tokenOut: DexTokenSymbol;
  amountIn: number;
  amountOut: number;
  minAmountOut: number;
  priceImpactBps: number;
  feeBps: number;
}

export interface LiquidityMiningProgram {
  programId: string;
  title: string;
  status: "pending" | "active" | "ended" | "cancelled";
  rewardAsset: string;
  rewardPerDayRaw: bigint;
  startAt: string;
  endAt: string;
  minLpTokensRaw: bigint;
  totalRewardsRaw: bigint | null;
  distributedRewardsRaw: bigint | null;
  governanceProposalId: number | null;
  dexes: string[];
  metadata: Record<string, unknown>;
}

export interface LiquidityMiningEstimate {
  programId: string;
  title: string;
  rewardAsset: string;
  estimatedDailyReward: number;
  estimatedDailyRewardRaw: bigint;
  userShareBps: number;
}

// ---- Pure math helpers ----

/** Convert a display amount (e.g. 10.5 XLM) to raw stroops (bigint). */
export function displayAmountToRaw(amount: number): bigint {
  return BigInt(Math.round(amount * 10_000_000));
}

/** Convert raw stroops (bigint) to a display amount (number). */
export function rawAmountToDisplay(raw: bigint | number): number {
  return Number(raw) / 10_000_000;
}

/**
 * Compute the instantaneous spot price: how many XLM per 1 sXLM.
 * Uses constant-product AMM formula: price = reserveXlm / reserveSxlm.
 */
export function computeSpotPrice(snapshot: PoolSnapshot): number {
  const sxlm = Number(snapshot.reserveSxlmRaw);
  if (sxlm === 0) return 1;
  return Number(snapshot.reserveXlmRaw) / sxlm;
}

/**
 * Quote an exact-in swap using the constant-product AMM formula with fee.
 *
 * @param snapshot  Current pool reserves.
 * @param tokenIn   Which asset is being sold.
 * @param amountIn  Raw stroop amount being sold.
 * @param slippageBps  Maximum acceptable slippage in basis points (e.g. 50 = 0.5%).
 */
export function quoteExactIn(
  snapshot: PoolSnapshot,
  tokenIn: DexTokenSymbol,
  amountIn: bigint,
  slippageBps: number
): SwapQuote {
  const feeBps = snapshot.feeBps ?? DEFAULT_SWAP_FEE_BPS;
  const amountInAfterFee = (amountIn * BigInt(10_000 - feeBps)) / 10_000n;

  const [reserveIn, reserveOut] =
    tokenIn === "XLM"
      ? [snapshot.reserveXlmRaw, snapshot.reserveSxlmRaw]
      : [snapshot.reserveSxlmRaw, snapshot.reserveXlmRaw];

  const tokenOut: DexTokenSymbol = tokenIn === "XLM" ? "sXLM" : "XLM";

  // constant-product: dy = y * dx / (x + dx)
  const amountOutRaw =
    reserveIn + amountInAfterFee === 0n
      ? 0n
      : (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);

  // price impact: how much we moved the price (in bps)
  const spotBefore = Number(reserveOut) / Number(reserveIn || 1n);
  const spotAfter =
    Number(reserveOut - amountOutRaw) / Number(reserveIn + amountInAfterFee || 1n);
  const priceImpactBps =
    spotBefore === 0 ? 0 : Math.round(((spotBefore - spotAfter) / spotBefore) * 10_000);

  const minAmountOutRaw =
    (amountOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;

  return {
    tokenIn,
    tokenOut,
    amountInRaw: amountIn,
    amountOutRaw,
    amountInDisplay: rawAmountToDisplay(amountIn),
    amountOutDisplay: rawAmountToDisplay(amountOutRaw),
    priceImpactBps,
    minAmountOutRaw,
    feeBps,
  };
}

/**
 * Compute TWAP price from a series of oracle observations.
 * Uses time-weighted average of consecutive spot prices.
 */
export function computeTwapPrice(
  observations: OracleObservation[],
  windowSeconds: number,
  now: Date
): OracleSnapshot {
  const spotPrice =
    observations.length > 0
      ? observations[observations.length - 1].spotPrice
      : 1;

  if (observations.length < 2) {
    return {
      twapPrice: spotPrice,
      spotPrice,
      windowSeconds,
      observations: observations.length,
      updatedAt: now.toISOString(),
    };
  }

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = 1; i < observations.length; i++) {
    const prev = observations[i - 1];
    const curr = observations[i];
    const deltaSeconds =
      (curr.observedAt.getTime() - prev.observedAt.getTime()) / 1_000;
    if (deltaSeconds > 0) {
      weightedSum += prev.spotPrice * deltaSeconds;
      totalWeight += deltaSeconds;
    }
  }

  const twapPrice = totalWeight > 0 ? weightedSum / totalWeight : spotPrice;

  return {
    twapPrice,
    spotPrice,
    windowSeconds,
    observations: observations.length,
    updatedAt: now.toISOString(),
  };
}

/**
 * Build DEX route objects from a quote for the given list of DEX names.
 */
export function buildDexRoutes(quote: SwapQuote, dexNames: string[]): DexRoute[] {
  return dexNames.map((dex) => ({
    dex,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountInDisplay,
    amountOut: quote.amountOutDisplay,
    minAmountOut: rawAmountToDisplay(quote.minAmountOutRaw),
    priceImpactBps: quote.priceImpactBps,
    feeBps: quote.feeBps,
  }));
}

/**
 * Estimate liquidity mining rewards for a user given their LP balance.
 */
export function estimateLiquidityMiningRewards(params: {
  program: LiquidityMiningProgram;
  userLpTokensRaw: bigint;
  totalLpSupplyRaw: bigint;
}): LiquidityMiningEstimate {
  const { program, userLpTokensRaw, totalLpSupplyRaw } = params;

  const userShareBps =
    totalLpSupplyRaw === 0n
      ? 0
      : Number((userLpTokensRaw * 10_000n) / totalLpSupplyRaw);

  const estimatedDailyRewardRaw =
    totalLpSupplyRaw === 0n
      ? 0n
      : (program.rewardPerDayRaw * userLpTokensRaw) / totalLpSupplyRaw;

  return {
    programId: program.programId,
    title: program.title,
    rewardAsset: program.rewardAsset,
    estimatedDailyReward: rawAmountToDisplay(estimatedDailyRewardRaw),
    estimatedDailyRewardRaw,
    userShareBps,
  };
}

/**
 * Parse a governance proposal paramKey/newValue pair into a LiquidityMiningProgram.
 * Returns null if the paramKey is not a liquidity mining program proposal.
 *
 * Expected format:
 *   paramKey: "liquidity_mining_program:<programId>"
 *   newValue: JSON-encoded LiquidityMiningProgram fields
 */
export function parseLiquidityMiningProgramProposal(
  paramKey: string,
  newValue: string,
  proposalId: number
): LiquidityMiningProgram | null {
  if (!paramKey.startsWith("liquidity_mining_program")) {
    return null;
  }

  try {
    const parsed = JSON.parse(newValue) as Partial<LiquidityMiningProgram>;

    const programId =
      parsed.programId ??
      paramKey.replace("liquidity_mining_program:", "") ??
      `program_${proposalId}`;

    return {
      programId,
      title: parsed.title ?? `Liquidity Mining Program #${proposalId}`,
      status: parsed.status ?? "pending",
      rewardAsset: parsed.rewardAsset ?? "sXLM",
      rewardPerDayRaw: BigInt(parsed.rewardPerDayRaw ?? 0),
      startAt: parsed.startAt ?? new Date().toISOString(),
      endAt: parsed.endAt ?? new Date(Date.now() + 30 * 86400_000).toISOString(),
      minLpTokensRaw: BigInt(parsed.minLpTokensRaw ?? 0),
      totalRewardsRaw:
        parsed.totalRewardsRaw != null ? BigInt(parsed.totalRewardsRaw) : null,
      distributedRewardsRaw:
        parsed.distributedRewardsRaw != null ? BigInt(parsed.distributedRewardsRaw) : 0n,
      governanceProposalId: proposalId,
      dexes: Array.isArray(parsed.dexes) ? parsed.dexes : [],
      metadata:
        parsed.metadata != null && typeof parsed.metadata === "object"
          ? (parsed.metadata as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}
