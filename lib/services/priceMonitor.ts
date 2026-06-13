import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getChainProvider } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { fetchSolanaPrice } from '../solana/jupiterPeg';
import { fetchCgPrices, type CgMap, type CgPrice } from './coinGecko';

import V2_PAIR_ABI  from '../abi/PancakeV2Pair.json';
import V3_POOL_ABI  from '../abi/UniswapV3Pool.json';

export interface PriceSnapshot {
  timestamp:    Date;
  price:        number;   // DEX spot price = stableReserve / tokenReserve (or V3 sqrtPriceX96 equivalent)
  tokenReserve: number;
  stableReserve:number;
  liquidityUsd: number;
  chain:        PegChain;
  tokenSymbol:  string;
  stableSymbol: string;
  blockNumber:  number;
  dexVersion:   'v2' | 'v3' | 'unknown';
  // CoinGecko market data — null when CG is unavailable / token not listed
  marketPriceUsd: number | null;
  cgChange24h:    number | null;
  cgVolume24h:    number | null;
  cgMarketCap:    number | null;
}

export interface PriceMonitorConfig {
  chain:         PegChain;
  tokenAddress:  string;
  stableAddress: string;
  pairAddress:   string;
}

const ERC20_DEC = ['function decimals() view returns (uint8)'];
const ERC20_SYM = ['function symbol() view returns (string)'];
const ERC20_BAL = ['function balanceOf(address) view returns (uint256)'];

// Convert V3 sqrtPriceX96 → human-readable price of the peg token in stable
function sqrtPriceX96ToHuman(
  sqrtPriceX96: bigint,
  token0Decimals: number,
  token1Decimals: number,
  tokenIsToken0: boolean,
): number {
  // Q64.96 → floating point: price of 1 wei token0 in wei token1
  const sqrtFloat = Number(sqrtPriceX96) / Number(2n ** 96n);
  const rawPrice  = sqrtFloat * sqrtFloat;
  // Adjust for decimals → price of 1 whole token0 in whole token1
  const adjusted  = rawPrice * Math.pow(10, token0Decimals - token1Decimals);
  // adjusted = (stable per token) if token is token0, else (token per stable)
  return tokenIsToken0 ? adjusted : 1 / adjusted;
}

class PriceMonitor extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  lastSnapshot: PriceSnapshot | null = null;

  private initKey:       string | null = null;
  private activeConfig:  PriceMonitorConfig | null = null;
  private poolVersion:   'v2' | 'v3' = 'v3';
  private tokenIsToken0 = true;
  private tokenDecimals  = 18;
  private stableDecimals = 18;
  private tokenSymbol    = '';
  private stableSymbol   = '';

  getPoolVersion(): 'v2' | 'v3' { return this.poolVersion; }

  async initialize(cfg: PriceMonitorConfig): Promise<void> {
    const key = `${cfg.chain}:${cfg.tokenAddress}:${cfg.pairAddress}`;
    if (this.initKey === key) return;

    if (cfg.chain === 'bsc' || cfg.chain === 'ethereum') {
      if (!cfg.pairAddress)   throw new Error(`Pair address required for ${cfg.chain}`);
      if (!cfg.tokenAddress)  throw new Error(`Token address required for ${cfg.chain}`);
      if (!cfg.stableAddress) throw new Error(`Stable address required for ${cfg.chain}`);

      const provider = getChainProvider(cfg.chain);

      // Probe pool version: V3 pools expose slot0(), V2 pools expose getReserves()
      let detectedVersion: 'v2' | 'v3' = 'v3';
      try {
        const probe = new ethers.Contract(cfg.pairAddress, V3_POOL_ABI, provider);
        await probe.slot0();
        detectedVersion = 'v3';
      } catch {
        detectedVersion = 'v2';
      }
      this.poolVersion = detectedVersion;

      const pairContract = new ethers.Contract(
        cfg.pairAddress,
        detectedVersion === 'v3' ? V3_POOL_ABI : V2_PAIR_ABI,
        provider,
      );

      const [t0, tDec, sDec, tSym, sSym] = await Promise.all([
        pairContract.token0() as Promise<string>,
        new ethers.Contract(cfg.tokenAddress,  ERC20_DEC, provider).decimals(),
        new ethers.Contract(cfg.stableAddress, ERC20_DEC, provider).decimals(),
        new ethers.Contract(cfg.tokenAddress,  ERC20_SYM, provider).symbol().catch(() => 'TOKEN'),
        new ethers.Contract(cfg.stableAddress, ERC20_SYM, provider).symbol().catch(() => 'STABLE'),
      ]);

      this.tokenIsToken0  = (t0 as string).toLowerCase() === cfg.tokenAddress.toLowerCase();
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
      version: this.poolVersion,
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

  // ── V3 price from slot0 ─────────────────────────────────────────────────────
  private async _getV3Price(
    provider: ethers.Provider,
    cfg: PriceMonitorConfig,
    cgPrices: CgMap,
    blockNumber: number,
  ): Promise<PriceSnapshot> {
    const pool = new ethers.Contract(cfg.pairAddress, V3_POOL_ABI, provider);
    const slot0 = await pool.slot0();
    const sqrtPriceX96 = BigInt(slot0[0].toString());

    const price = sqrtPriceX96ToHuman(
      sqrtPriceX96,
      this.tokenDecimals,
      this.stableDecimals,
      this.tokenIsToken0,
    );

    // Use ERC20 balanceOf(pool) as "reserves" — gives total token depth in pool
    const [tokenRaw, stableRaw] = await Promise.all([
      new ethers.Contract(cfg.tokenAddress,  ERC20_BAL, provider).balanceOf(cfg.pairAddress) as Promise<bigint>,
      new ethers.Contract(cfg.stableAddress, ERC20_BAL, provider).balanceOf(cfg.pairAddress) as Promise<bigint>,
    ]);
    const tokenR  = parseFloat(ethers.formatUnits(tokenRaw,  this.tokenDecimals));
    const stableR = parseFloat(ethers.formatUnits(stableRaw, this.stableDecimals));

    const cgToken  = cgPrices[cfg.tokenAddress.toLowerCase()]  ?? null;
    const cgStable = cgPrices[cfg.stableAddress.toLowerCase()] ?? null;
    const stableUsd   = cgStable?.usd ?? 1.0;
    const tokenUsd    = cgToken?.usd  ?? (price * stableUsd);
    const liquidityUsd = tokenR * tokenUsd + stableR * stableUsd;

    return {
      timestamp: new Date(), price,
      tokenReserve: tokenR, stableReserve: stableR, liquidityUsd,
      chain: cfg.chain,
      tokenSymbol:  this.tokenSymbol,
      stableSymbol: this.stableSymbol,
      blockNumber,
      dexVersion: 'v3',
      marketPriceUsd: cgToken?.usd            ?? null,
      cgChange24h:    cgToken?.usd_24h_change ?? null,
      cgVolume24h:    cgToken?.usd_24h_vol    ?? null,
      cgMarketCap:    cgToken?.usd_market_cap ?? null,
    };
  }

  // ── V2 price from getReserves ───────────────────────────────────────────────
  private async _getV2Price(
    provider: ethers.Provider,
    cfg: PriceMonitorConfig,
    cgPrices: CgMap,
    blockNumber: number,
  ): Promise<PriceSnapshot> {
    const pair = new ethers.Contract(cfg.pairAddress, V2_PAIR_ABI, provider);
    const reserves = await pair.getReserves();

    const raw0 = BigInt(reserves[0].toString());
    const raw1 = BigInt(reserves[1].toString());
    const tokenRaw  = this.tokenIsToken0 ? raw0 : raw1;
    const stableRaw = this.tokenIsToken0 ? raw1 : raw0;
    const tokenR  = parseFloat(ethers.formatUnits(tokenRaw,  this.tokenDecimals));
    const stableR = parseFloat(ethers.formatUnits(stableRaw, this.stableDecimals));
    const price   = tokenR > 0 ? stableR / tokenR : 0;

    const cgToken  = cgPrices[cfg.tokenAddress.toLowerCase()]  ?? null;
    const cgStable = cgPrices[cfg.stableAddress.toLowerCase()] ?? null;
    const stableUsd   = cgStable?.usd ?? 1.0;
    const tokenUsd    = cgToken?.usd  ?? (price * stableUsd);
    const liquidityUsd = tokenR * tokenUsd + stableR * stableUsd;

    return {
      timestamp: new Date(), price,
      tokenReserve: tokenR, stableReserve: stableR, liquidityUsd,
      chain: cfg.chain,
      tokenSymbol:  this.tokenSymbol,
      stableSymbol: this.stableSymbol,
      blockNumber,
      dexVersion: 'v2',
      marketPriceUsd: cgToken?.usd            ?? null,
      cgChange24h:    cgToken?.usd_24h_change ?? null,
      cgVolume24h:    cgToken?.usd_24h_vol    ?? null,
      cgMarketCap:    cgToken?.usd_market_cap ?? null,
    };
  }

  private async _getEvmPrice(chain: 'bsc' | 'ethereum'): Promise<PriceSnapshot> {
    const cfg      = this.activeConfig!;
    const provider = getChainProvider(chain);

    const [blockNumber, cgPrices] = await Promise.all([
      provider.getBlockNumber(),
      fetchCgPrices(chain, [cfg.tokenAddress, cfg.stableAddress]).catch((): CgMap => ({})),
    ]);

    const snap = this.poolVersion === 'v3'
      ? await this._getV3Price(provider, cfg, cgPrices, blockNumber)
      : await this._getV2Price(provider, cfg, cgPrices, blockNumber);

    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  // Cold read — does NOT require the monitor to be started.
  async getOnChainPrice(cfg: PriceMonitorConfig): Promise<PriceSnapshot> {
    if (cfg.chain !== 'bsc' && cfg.chain !== 'ethereum') {
      throw new Error('Solana on-chain price requires active monitor');
    }
    const provider = getChainProvider(cfg.chain);

    const ERC20_META = [
      'function decimals() view returns (uint8)',
      'function symbol()   view returns (string)',
    ];

    // Detect V2 or V3
    let version: 'v2' | 'v3' = 'v3';
    try {
      const probe = new ethers.Contract(cfg.pairAddress, V3_POOL_ABI, provider);
      await probe.slot0();
    } catch {
      version = 'v2';
    }

    const pairContract = new ethers.Contract(
      cfg.pairAddress,
      version === 'v3' ? V3_POOL_ABI : V2_PAIR_ABI,
      provider,
    );

    const [t0, blockNumber, tokenDec, stableDec, tokenSym, stableSym, cgPrices] = await Promise.all([
      pairContract.token0()                                                                                    as Promise<string>,
      provider.getBlockNumber(),
      new ethers.Contract(cfg.tokenAddress,  ERC20_META, provider).decimals().catch(() => BigInt(18)) as Promise<bigint>,
      new ethers.Contract(cfg.stableAddress, ERC20_META, provider).decimals().catch(() => BigInt(18)) as Promise<bigint>,
      new ethers.Contract(cfg.tokenAddress,  ERC20_META, provider).symbol().catch(() => 'TOKEN')      as Promise<string>,
      new ethers.Contract(cfg.stableAddress, ERC20_META, provider).symbol().catch(() => 'STABLE')     as Promise<string>,
      fetchCgPrices(cfg.chain as 'bsc' | 'ethereum', [cfg.tokenAddress, cfg.stableAddress]).catch((): CgMap => ({})),
    ]);

    const tokenIsToken0 = (t0 as string).toLowerCase() === cfg.tokenAddress.toLowerCase();
    const tDec = Math.max(1, Number(tokenDec));
    const sDec = Math.max(1, Number(stableDec));

    let price = 0, tokenR = 0, stableR = 0;

    if (version === 'v3') {
      const slot0 = await (pairContract as ethers.Contract).slot0();
      price  = sqrtPriceX96ToHuman(BigInt(slot0[0].toString()), tDec, sDec, tokenIsToken0);
      const [tokenRaw, stableRaw] = await Promise.all([
        new ethers.Contract(cfg.tokenAddress,  ERC20_BAL, provider).balanceOf(cfg.pairAddress) as Promise<bigint>,
        new ethers.Contract(cfg.stableAddress, ERC20_BAL, provider).balanceOf(cfg.pairAddress) as Promise<bigint>,
      ]);
      tokenR  = parseFloat(ethers.formatUnits(tokenRaw,  tDec));
      stableR = parseFloat(ethers.formatUnits(stableRaw, sDec));
    } else {
      const reserves = await (pairContract as ethers.Contract).getReserves();
      const raw0 = BigInt(reserves[0].toString());
      const raw1 = BigInt(reserves[1].toString());
      const tokenRaw  = tokenIsToken0 ? raw0 : raw1;
      const stableRaw = tokenIsToken0 ? raw1 : raw0;
      tokenR  = parseFloat(ethers.formatUnits(tokenRaw,  tDec));
      stableR = parseFloat(ethers.formatUnits(stableRaw, sDec));
      price   = tokenR > 0 ? stableR / tokenR : 0;
    }

    const cgToken  = cgPrices[cfg.tokenAddress.toLowerCase()]  ?? null;
    const cgStable = cgPrices[cfg.stableAddress.toLowerCase()] ?? null;
    const stableUsd   = cgStable?.usd ?? 1.0;
    const tokenUsd    = cgToken?.usd  ?? (price * stableUsd);
    const liquidityUsd = tokenR * tokenUsd + stableR * stableUsd;

    logger.info('getOnChainPrice', {
      version, pair: cfg.pairAddress.slice(0, 10),
      tokenIsToken0, dexPrice: price.toFixed(8),
    });

    return {
      timestamp: new Date(), price,
      tokenReserve: tokenR, stableReserve: stableR, liquidityUsd,
      chain: cfg.chain,
      tokenSymbol:  tokenSym as string,
      stableSymbol: stableSym as string,
      blockNumber:  blockNumber as number,
      dexVersion:   version,
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
      chain: 'solana', dexVersion: 'unknown',
      tokenSymbol: '', stableSymbol: '', blockNumber: 0,
      marketPriceUsd: null, cgChange24h: null, cgVolume24h: null, cgMarketCap: null,
    };
    this.lastSnapshot = snap;
    this.emit('price', snap);
    return snap;
  }

  getLastSnapshot() { return this.lastSnapshot; }

  // AMM math — V2 constant-product approximation (used as trade-size estimator)
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
