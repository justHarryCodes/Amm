import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getChainProvider } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { fetchSolanaPrice } from '../solana/jupiterPeg';

import PAIR_ABI from '../abi/PancakeV2Pair.json';

export interface PriceSnapshot {
  timestamp: Date;
  price: number;
  tokenReserve: number;
  stableReserve: number;
  liquidityUsd: number;
  chain: PegChain;
}

// Minimal view of settings needed for price monitoring
export interface PriceMonitorConfig {
  chain: PegChain;
  tokenAddress:  string;
  stableAddress: string;
  pairAddress:   string;
}

const ERC20_DEC = ['function decimals() view returns (uint8)'];

class PriceMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  lastSnapshot: PriceSnapshot | null = null;

  // State keyed by init token+pair so re-init happens when addresses change
  private initKey: string | null = null;
  private activeConfig: PriceMonitorConfig | null = null;
  private tokenIsToken0 = true;
  private tokenDecimals  = 18;
  private stableDecimals = 18;

  // Pass the full peg settings so the monitor knows which addresses to use
  async initialize(cfg: PriceMonitorConfig): Promise<void> {
    const key = `${cfg.chain}:${cfg.tokenAddress}:${cfg.pairAddress}`;
    if (this.initKey === key) return;

    if (cfg.chain === 'bsc' || cfg.chain === 'ethereum') {
      if (!cfg.pairAddress)   throw new Error(`Pair address required for ${cfg.chain}`);
      if (!cfg.tokenAddress)  throw new Error(`Token address required for ${cfg.chain}`);
      if (!cfg.stableAddress) throw new Error(`Stable address required for ${cfg.chain}`);

      const provider = getChainProvider(cfg.chain);
      const pair = new ethers.Contract(cfg.pairAddress, PAIR_ABI, provider);
      const [t0] = await Promise.all([pair.token0()]);
      this.tokenIsToken0 = (t0 as string).toLowerCase() === cfg.tokenAddress.toLowerCase();

      const [tDec, sDec] = await Promise.all([
        new ethers.Contract(cfg.tokenAddress,  ERC20_DEC, provider).decimals(),
        new ethers.Contract(cfg.stableAddress, ERC20_DEC, provider).decimals(),
      ]);
      this.tokenDecimals  = Number(tDec);
      this.stableDecimals = Number(sDec);
    } else {
      // Solana: validate mints only — Jupiter is stateless
      if (!cfg.tokenAddress)  throw new Error('Token mint required for Solana');
      if (!cfg.stableAddress) throw new Error('Stable mint required for Solana');
    }

    this.initKey     = key;
    this.activeConfig = { ...cfg };
    logger.info('PriceMonitor initialized', {
      chain: cfg.chain,
      token: cfg.tokenAddress.slice(0, 10) + '…',
    });
  }

  async getPrice(chain?: PegChain): Promise<PriceSnapshot> {
    const c = chain ?? this.activeConfig?.chain ?? config.peg.chain;
    if (c === 'solana') return this._getSolanaPrice();
    return this._getEvmPrice(c as 'bsc' | 'ethereum');
  }

  private async _getEvmPrice(chain: 'bsc' | 'ethereum'): Promise<PriceSnapshot> {
    const cfg = this.activeConfig!;
    const provider = getChainProvider(chain);
    const pair = new ethers.Contract(cfg.pairAddress, PAIR_ABI, provider);
    const reserves = await pair.getReserves();
    const r0 = BigInt(reserves.reserve0);
    const r1 = BigInt(reserves.reserve1);

    const tokenR  = parseFloat(ethers.formatUnits(this.tokenIsToken0 ? r0 : r1, this.tokenDecimals));
    const stableR = parseFloat(ethers.formatUnits(this.tokenIsToken0 ? r1 : r0, this.stableDecimals));
    const price   = tokenR > 0 ? stableR / tokenR : 0;

    const snap: PriceSnapshot = {
      timestamp: new Date(), price,
      tokenReserve: tokenR, stableReserve: stableR,
      liquidityUsd: stableR * 2, chain,
    };
    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  private async _getSolanaPrice(): Promise<PriceSnapshot> {
    const cfg = this.activeConfig!;
    const result = await fetchSolanaPrice(cfg.tokenAddress, cfg.stableAddress);
    const snap: PriceSnapshot = {
      timestamp: result.timestamp, price: result.price,
      tokenReserve: 0, stableReserve: 0,
      liquidityUsd: 0, chain: 'solana',
    };
    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  getLastSnapshot() { return this.lastSnapshot; }

  // AMM constant-product math for EVM (Uniswap V2 invariant: k = r*s)
  calcSellAmount(snap: PriceSnapshot, target: number): number {
    const { tokenReserve: r, stableReserve: s } = snap;
    if (snap.chain === 'solana' || r === 0 || s === 0) {
      return config.peg.maxTradeSizeTokens * 0.01;
    }
    const k = r * s;
    return Math.max(0, (Math.sqrt(k / target) - r) / 0.9975);
  }

  calcBuyAmount(snap: PriceSnapshot, target: number): number {
    const { tokenReserve: r, stableReserve: s } = snap;
    if (snap.chain === 'solana' || r === 0 || s === 0) {
      return config.peg.maxTradeSizeTokens * snap.price * 0.01;
    }
    const k = r * s;
    return Math.max(0, (Math.sqrt(k * target) - s) / 0.9975);
  }

  async savePriceHistory(snap: PriceSnapshot): Promise<void> {
    try {
      await query(
        `INSERT INTO price_history (timestamp, price, token_reserve, stable_reserve, liquidity_usd)
         VALUES ($1,$2,$3,$4,$5)`,
        [snap.timestamp, snap.price, snap.tokenReserve, snap.stableReserve, snap.liquidityUsd]
      );
    } catch { /* non-fatal */ }
  }

  start(chain: PegChain, ms = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const snap = await this.getPrice(chain);
        await this.savePriceHistory(snap);
      } catch (e: unknown) {
        logger.error('Price poll error', { chain, err: (e as Error).message });
      }
    }, ms);
    logger.info('PriceMonitor polling started', { chain });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.initKey     = null;
    this.activeConfig = null;
    logger.info('PriceMonitor stopped');
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __priceMonitor: PriceMonitor | undefined }
export const priceMonitor: PriceMonitor = global.__priceMonitor ?? new PriceMonitor();
global.__priceMonitor = priceMonitor;
