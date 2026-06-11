import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getChainProvider } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { fetchSolanaPrice } from '../solana/jupiterPeg';
import { fetchCgPrices, type CgMap, type CgPrice } from './coinGecko';

import PAIR_ABI from '../abi/PancakeV2Pair.json';

export interface PriceSnapshot {
  timestamp:    Date;
  price:        number;   // DEX spot price = stableReserve / tokenReserve (trading price)
  tokenReserve: number;
  stableReserve:number;
  liquidityUsd: number;   // tokenR × cgTokenUsd + stableR × cgStableUsd
  chain:        PegChain;
  tokenSymbol:  string;
  stableSymbol: string;
  blockNumber:  number;
  // CoinGecko market data — null when CG is unavailable / token not listed
  marketPriceUsd: number | null;  // CoinGecko USD price (market-wide, not just this DEX)
  cgChange24h:    number | null;  // 24-hour % price change
  cgVolume24h:    number | null;  // 24-hour USD trading volume
  cgMarketCap:    number | null;  // USD market cap
}

// Minimal view of settings needed for price monitoring
export interface PriceMonitorConfig {
  chain:         PegChain;
  tokenAddress:  string;
  stableAddress: string;
  pairAddress:   string;
}

const ERC20_DEC = ['function decimals() view returns (uint8)'];
const ERC20_SYM = ['function symbol() view returns (string)'];

class PriceMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  lastSnapshot: PriceSnapshot | null = null;

  private initKey:      string | null = null;
  private activeConfig: PriceMonitorConfig | null = null;
  private tokenIsToken0  = true;
  private tokenDecimals  = 18;
  private stableDecimals = 18;
  private tokenSymbol    = '';
  private stableSymbol   = '';

  async initialize(cfg: PriceMonitorConfig): Promise<void> {
    const key = `${cfg.chain}:${cfg.tokenAddress}:${cfg.pairAddress}`;
    if (this.initKey === key) return;

    if (cfg.chain === 'bsc' || cfg.chain === 'ethereum') {
      if (!cfg.pairAddress)   throw new Error(`Pair address required for ${cfg.chain}`);
      if (!cfg.tokenAddress)  throw new Error(`Token address required for ${cfg.chain}`);
      if (!cfg.stableAddress) throw new Error(`Stable address required for ${cfg.chain}`);

      const provider = getChainProvider(cfg.chain);
      // Use the inputted pair address directly — validate it answers token0()
      const pair = new ethers.Contract(cfg.pairAddress, PAIR_ABI, provider);

      const [t0, tDec, sDec, tSym, sSym] = await Promise.all([
        pair.token0() as Promise<string>,
        new ethers.Contract(cfg.tokenAddress,  ERC20_DEC, provider).decimals(),
        new ethers.Contract(cfg.stableAddress, ERC20_DEC, provider).decimals(),
        new ethers.Contract(cfg.tokenAddress,  ERC20_SYM, provider).symbol().catch(() => 'TOKEN'),
        new ethers.Contract(cfg.stableAddress, ERC20_SYM, provider).symbol().catch(() => 'STABLE'),
      ]);

      this.tokenIsToken0  = t0.toLowerCase() === cfg.tokenAddress.toLowerCase();
      this.tokenDecimals  = Number(tDec);
      this.stableDecimals = Number(sDec);
      this.tokenSymbol    = tSym as string;
      this.stableSymbol   = sSym as string;
    } else {
      if (!cfg.tokenAddress)  throw new Error('Token mint required for Solana');
      if (!cfg.stableAddress) throw new Error('Stable mint required for Solana');
    }

    this.initKey      = key;
    this.activeConfig = { ...cfg };
    logger.info('PriceMonitor initialized', {
      chain: cfg.chain,
      pair:  cfg.pairAddress.slice(0, 10) + '…',
      token: cfg.tokenAddress.slice(0, 10) + '…',
      tokenIsToken0: this.tokenIsToken0,
    });
  }

  async getPrice(chain?: PegChain): Promise<PriceSnapshot> {
    const c = chain ?? this.activeConfig?.chain ?? config.peg.chain;
    if (c === 'solana') return this._getSolanaPrice();
    return this._getEvmPrice(c as 'bsc' | 'ethereum');
  }

  // Shared helper: turn raw getReserves() output + decimals into human-readable amounts
  private static _parseReserves(
    reserves: { reserve0: bigint; reserve1: bigint } | bigint[],
    tokenIsToken0: boolean,
    tokenDecimals: number,
    stableDecimals: number,
  ): { tokenR: number; stableR: number } {
    // ethers v6 Result supports both named and indexed access
    const raw0 = BigInt(((reserves as { reserve0: bigint }).reserve0 ?? (reserves as bigint[])[0]).toString());
    const raw1 = BigInt(((reserves as { reserve1: bigint }).reserve1 ?? (reserves as bigint[])[1]).toString());
    const tokenRaw  = tokenIsToken0 ? raw0 : raw1;
    const stableRaw = tokenIsToken0 ? raw1 : raw0;
    return {
      tokenR:  parseFloat(ethers.formatUnits(tokenRaw,  tokenDecimals)),
      stableR: parseFloat(ethers.formatUnits(stableRaw, stableDecimals)),
    };
  }

  // Shared helper: DEX spot price + liquidity from reserves + CoinGecko data
  private static _calcPriceAndLiquidity(
    tokenR: number, stableR: number,
    tokenAddr: string, stableAddr: string,
    cgPrices: CgMap,
  ): { dexPrice: number; liquidityUsd: number; cgToken: CgPrice | null; cgStable: CgPrice | null } {
    // Spot price: how many stable tokens buy 1 token (the actual trading price on this pair)
    const dexPrice = tokenR > 0 ? stableR / tokenR : 0;

    const cgToken  = cgPrices[tokenAddr.toLowerCase()]  ?? null;
    const cgStable = cgPrices[stableAddr.toLowerCase()] ?? null;

    // USD price of 1 stable token (USDT/USDC ≈ 1, WBNB = $300+, etc.)
    const stableUsd = cgStable?.usd ?? 1.0;
    // USD price of 1 project token — prefer CoinGecko, fallback to DEX price × stable
    const tokenUsd  = cgToken?.usd ?? (dexPrice * stableUsd);

    // Accurate pool liquidity = sum of both sides at real USD prices
    const liquidityUsd = tokenR * tokenUsd + stableR * stableUsd;

    return { dexPrice, liquidityUsd, cgToken, cgStable };
  }

  // Live price read using the active (initialized) config
  private async _getEvmPrice(chain: 'bsc' | 'ethereum'): Promise<PriceSnapshot> {
    const cfg = this.activeConfig!;
    const provider = getChainProvider(chain);
    const pair = new ethers.Contract(cfg.pairAddress, PAIR_ABI, provider);

    const [[reserves, blockNumber], cgPrices] = await Promise.all([
      Promise.all([pair.getReserves(), provider.getBlockNumber()]),
      fetchCgPrices(chain, [cfg.tokenAddress, cfg.stableAddress]).catch((): CgMap => ({})),
    ]);

    const { tokenR, stableR } = PriceMonitor._parseReserves(
      reserves as { reserve0: bigint; reserve1: bigint },
      this.tokenIsToken0, this.tokenDecimals, this.stableDecimals,
    );
    const { dexPrice, liquidityUsd, cgToken } = PriceMonitor._calcPriceAndLiquidity(
      tokenR, stableR, cfg.tokenAddress, cfg.stableAddress, cgPrices,
    );

    const snap: PriceSnapshot = {
      timestamp: new Date(), price: dexPrice,
      tokenReserve: tokenR, stableReserve: stableR, liquidityUsd,
      chain,
      tokenSymbol:  this.tokenSymbol,
      stableSymbol: this.stableSymbol,
      blockNumber:  blockNumber as number,
      marketPriceUsd: cgToken?.usd            ?? null,
      cgChange24h:    cgToken?.usd_24h_change ?? null,
      cgVolume24h:    cgToken?.usd_24h_vol    ?? null,
      cgMarketCap:    cgToken?.usd_market_cap ?? null,
    };
    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  // Cold read — does NOT require the monitor to be started.
  // Used by the status and dashboard APIs when the bot is stopped.
  async getOnChainPrice(cfg: PriceMonitorConfig): Promise<PriceSnapshot> {
    if (cfg.chain !== 'bsc' && cfg.chain !== 'ethereum') {
      throw new Error('Solana on-chain price requires active monitor');
    }
    const provider = getChainProvider(cfg.chain);
    const pair = new ethers.Contract(cfg.pairAddress, PAIR_ABI, provider);

    const ERC20_META = [
      'function decimals() view returns (uint8)',
      'function symbol()   view returns (string)',
    ];

    // Fetch everything in one round-trip: pair metadata + ERC20 metadata + CoinGecko
    const [
      [t0, reserves, blockNumber, tokenDec, stableDec, tokenSym, stableSym],
      cgPrices,
    ] = await Promise.all([
      Promise.all([
        pair.token0()                                                                                    as Promise<string>,
        pair.getReserves(),
        provider.getBlockNumber(),
        new ethers.Contract(cfg.tokenAddress,  ERC20_META, provider).decimals().catch(() => BigInt(18)) as Promise<bigint>,
        new ethers.Contract(cfg.stableAddress, ERC20_META, provider).decimals().catch(() => BigInt(18)) as Promise<bigint>,
        new ethers.Contract(cfg.tokenAddress,  ERC20_META, provider).symbol().catch(() => 'TOKEN')      as Promise<string>,
        new ethers.Contract(cfg.stableAddress, ERC20_META, provider).symbol().catch(() => 'STABLE')     as Promise<string>,
      ]),
      fetchCgPrices(cfg.chain as 'bsc' | 'ethereum', [cfg.tokenAddress, cfg.stableAddress]).catch((): CgMap => ({})),
    ]);

    const tokenIsToken0 = (t0 as string).toLowerCase() === cfg.tokenAddress.toLowerCase();
    const tDec = Math.max(1, Number(tokenDec));   // guard: decimals must be ≥ 1
    const sDec = Math.max(1, Number(stableDec));

    const { tokenR, stableR } = PriceMonitor._parseReserves(
      reserves as { reserve0: bigint; reserve1: bigint },
      tokenIsToken0, tDec, sDec,
    );
    const { dexPrice, liquidityUsd, cgToken } = PriceMonitor._calcPriceAndLiquidity(
      tokenR, stableR, cfg.tokenAddress, cfg.stableAddress, cgPrices,
    );

    logger.info('getOnChainPrice', {
      pair: cfg.pairAddress.slice(0, 10),
      tokenIsToken0,
      tokenR: tokenR.toFixed(4),
      stableR: stableR.toFixed(4),
      dexPrice: dexPrice.toFixed(8),
      liquidityUsd: liquidityUsd.toFixed(2),
    });

    return {
      timestamp: new Date(), price: dexPrice,
      tokenReserve: tokenR, stableReserve: stableR, liquidityUsd,
      chain: cfg.chain,
      tokenSymbol:  tokenSym as string,
      stableSymbol: stableSym as string,
      blockNumber:  blockNumber as number,
      marketPriceUsd: cgToken?.usd            ?? null,
      cgChange24h:    cgToken?.usd_24h_change ?? null,
      cgVolume24h:    cgToken?.usd_24h_vol    ?? null,
      cgMarketCap:    cgToken?.usd_market_cap ?? null,
    };
  }

  private async _getSolanaPrice(): Promise<PriceSnapshot> {
    const cfg = this.activeConfig!;
    const result = await fetchSolanaPrice(cfg.tokenAddress, cfg.stableAddress);
    const snap: PriceSnapshot = {
      timestamp: result.timestamp, price: result.price,
      tokenReserve: 0, stableReserve: 0, liquidityUsd: 0,
      chain: 'solana',
      tokenSymbol: '', stableSymbol: '', blockNumber: 0,
      marketPriceUsd: null, cgChange24h: null, cgVolume24h: null, cgMarketCap: null,
    };
    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  getLastSnapshot() { return this.lastSnapshot; }

  // AMM constant-product math (Uniswap V2: k = r × s)
  calcSellAmount(snap: PriceSnapshot, target: number): number {
    const { tokenReserve: r, stableReserve: s } = snap;
    if (snap.chain === 'solana' || r === 0 || s === 0)
      return config.peg.maxTradeSizeTokens * 0.01;
    const k = r * s;
    return Math.max(0, (Math.sqrt(k / target) - r) / 0.9975);
  }

  calcBuyAmount(snap: PriceSnapshot, target: number): number {
    const { tokenReserve: r, stableReserve: s } = snap;
    if (snap.chain === 'solana' || r === 0 || s === 0)
      return config.peg.maxTradeSizeTokens * snap.price * 0.01;
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
    logger.info('PriceMonitor polling started', { chain, intervalMs: ms });
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.initKey      = null;
    this.activeConfig = null;
    logger.info('PriceMonitor stopped');
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __priceMonitor: PriceMonitor | undefined }
export const priceMonitor: PriceMonitor = global.__priceMonitor ?? new PriceMonitor();
global.__priceMonitor = priceMonitor;
