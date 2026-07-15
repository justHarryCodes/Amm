import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getPriceMonitorSlot, PriceMonitor, PriceSnapshot } from './priceMonitor';
import { getChainSigner, getChainProvider, getGasPrice } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { getSolanaConnection, getSolanaKeypair } from '../solana/connection';
import { getMintDecimals } from '../solana/splTransfer';
import { executeJupiterSwap } from '../solana/jupiterPeg';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

import PANCAKE_V3_ROUTER_ABI from '../abi/PancakeV3Router.json';
import UNISWAP_V3_ROUTER_ABI from '../abi/UniswapV3Router.json';
import V3_POOL_ABI            from '../abi/UniswapV3Pool.json';
import V3_FACTORY_ABI         from '../abi/UniswapV3Factory.json';
import V2_PAIR_ABI            from '../abi/PancakeV2Pair.json';
import ERC20_ABI              from '../abi/ERC20.json';
import { txOverrides, ensureApproval } from '../blockchain/contracts';
import { CHAIN_TOKENS, V3_FEE_TIERS, type V3FeeTier } from '../tokens';

function getRouter(chain: 'bsc' | 'ethereum'): string {
  return CHAIN_TOKENS[chain].router;
}

export type BotState = 'STOPPED' | 'MONITOR_ONLY' | 'AUTO_TRADE' | 'PAUSED';

export interface PegSettings {
  chain: PegChain;

  // Token configuration
  tokenAddress:  string;
  stableAddress: string;
  pairAddress:   string;
  routerAddress: string;
  poolFeeTier:   number;  // V3 fee tier (100/500/2500/3000/10000)

  // Safety limits
  targetPeg:          number;
  upperBand:          number;
  lowerBand:          number;
  maxTradeSizeTokens: number;
  maxDailySpendUsd:   number;
  minLiquidityUsd:    number;
  cooldownSeconds:    number;
  slippageTolerance:  number;

  // Volume generation
  volumeEnabled:         boolean;
  volumeIntervalSeconds: number;
  volumeSwapSizeUsd:     number;
}

export interface TradeRecord {
  id?: number; timestamp: Date; action: 'BUY' | 'SELL';
  chain: PegChain;
  tokenAmount: number; stableAmount: number;
  priceBefore: number; priceAfter: number | null;
  txHash: string | null; status: 'SUCCESS' | 'FAILED' | 'PENDING'; error?: string;
  isVolumeTrade?: boolean;
}

function chainDefaults(chain: PegChain): Pick<PegSettings, 'tokenAddress' | 'stableAddress' | 'pairAddress' | 'routerAddress' | 'poolFeeTier'> {
  if (chain === 'bsc') return {
    tokenAddress:  config.pegChains.bsc.tokenAddress,
    stableAddress: config.pegChains.bsc.stableAddress,
    pairAddress:   config.pegChains.bsc.pairAddress,
    routerAddress: config.pegChains.bsc.routerAddress,
    poolFeeTier:   CHAIN_TOKENS.bsc.defaultFeeTier,
  };
  if (chain === 'ethereum') return {
    tokenAddress:  config.pegChains.ethereum.tokenAddress,
    stableAddress: config.pegChains.ethereum.stableAddress,
    pairAddress:   config.pegChains.ethereum.pairAddress,
    routerAddress: config.pegChains.ethereum.routerAddress,
    poolFeeTier:   CHAIN_TOKENS.ethereum.defaultFeeTier,
  };
  return {
    tokenAddress:  config.pegChains.solana.tokenMint,
    stableAddress: config.pegChains.solana.stableMint,
    pairAddress:   '',
    routerAddress: '',
    poolFeeTier:   0,
  };
}

function initialSettings(): PegSettings {
  const chain = config.peg.chain;
  return {
    chain,
    ...chainDefaults(chain),
    targetPeg:          config.peg.targetPeg,
    upperBand:          config.peg.upperBand,
    lowerBand:          config.peg.lowerBand,
    maxTradeSizeTokens: config.peg.maxTradeSizeTokens,
    maxDailySpendUsd:   config.peg.maxDailySpendUsd,
    minLiquidityUsd:    config.peg.minLiquidityUsd,
    cooldownSeconds:    config.peg.cooldownSeconds,
    slippageTolerance:  config.peg.slippageTolerance,
    volumeEnabled:         false,
    volumeIntervalSeconds: 120,
    volumeSwapSizeUsd:     10,
  };
}

// One-time migration to add slot column to peg_trades
let _slotColumnEnsured = false;
async function ensureSlotColumn(): Promise<void> {
  if (_slotColumnEnsured) return;
  await query('ALTER TABLE peg_trades ADD COLUMN IF NOT EXISTS slot SMALLINT NOT NULL DEFAULT 0').catch(() => {});
  _slotColumnEnsured = true;
}

class PegMaintainer extends EventEmitter {
  state: BotState = 'STOPPED';
  settings: PegSettings;

  lastTradeAt: Date | null = null;
  dailySpendUsd = 0;
  private dailySpendResetAt = new Date();

  private _volumeTimer: ReturnType<typeof setInterval> | null = null;
  private _volumeDirection: 'BUY' | 'SELL' = 'BUY';

  constructor(
    private readonly slot: number,
    private readonly monitor: PriceMonitor,
  ) {
    super();
    this.settings = initialSettings();
  }

  updateSettings(partial: Partial<PegSettings>): void {
    if (partial.chain && partial.chain !== this.settings.chain) {
      if (this.state !== 'STOPPED') throw new Error('Stop the bot before changing chain');
      this.settings = { ...this.settings, ...chainDefaults(partial.chain), ...partial };
    } else {
      this.settings = { ...this.settings, ...partial };
    }
    logger.info('Peg settings updated', { slot: this.slot, chain: this.settings.chain, token: this.settings.tokenAddress.slice(0, 10) });

    // Live-toggle volume loop when bot is already running
    if (this.state === 'AUTO_TRADE') {
      if (this.settings.volumeEnabled && !this._volumeTimer) {
        this._startVolumeLoop();
      } else if (!this.settings.volumeEnabled && this._volumeTimer) {
        this._stopVolumeLoop();
      } else if (this.settings.volumeEnabled && this._volumeTimer && partial.volumeIntervalSeconds) {
        this._stopVolumeLoop();
        this._startVolumeLoop();
      }
    }

    this.emit('stateChange', this.state);
    void this.saveState();
  }

  async start(mode: 'MONITOR_ONLY' | 'AUTO_TRADE'): Promise<void> {
    if (this.state !== 'STOPPED') return;
    this._validateSettings();
    try { await this.monitor.initialize(this.settings); }
    catch (e: unknown) { throw new Error(`PriceMonitor init failed: ${(e as Error).message}`); }

    // For V3 pools: verify the pool is registered in the official factory
    const { chain, pairAddress, tokenAddress, stableAddress } = this.settings;
    if ((chain === 'bsc' || chain === 'ethereum') && pairAddress && this.monitor.getPoolVersion() === 'v3') {
      try {
        const provider  = getChainProvider(chain);
        const factory   = new ethers.Contract(CHAIN_TOKENS[chain].factory, V3_FACTORY_ABI, provider);

        const pool    = new ethers.Contract(pairAddress, V3_POOL_ABI, provider);
        const poolFee = Number(await pool.fee());

        const factoryPool = poolFee
          ? String(await factory.getPool(tokenAddress, stableAddress, poolFee))
          : ethers.ZeroAddress;
        const factoryKnows = factoryPool.toLowerCase() === pairAddress.toLowerCase();

        if (factoryKnows && poolFee) {
          logger.info('V3 pool verified via factory', { fee: poolFee, pool: pairAddress });
          this.settings.poolFeeTier = poolFee;
        } else {
          logger.warn('Pool not in factory at fee, scanning tiers', { poolFee, factoryPool, pairAddress });
          let found = false;
          for (const tier of V3_FEE_TIERS) {
            const p = String(await factory.getPool(tokenAddress, stableAddress, tier));
            if (p && p !== ethers.ZeroAddress) {
              logger.info('Found pool via factory fee scan', { fee: tier, pool: p });
              this.settings.poolFeeTier = tier;
              found = true;
              break;
            }
          }
          if (!found) {
            logger.warn('Pool not found in official factory — SmartRouter may not be able to route this pair. Trades will likely fail.', { pairAddress });
          }
        }
      } catch (e: unknown) {
        logger.warn('Pool factory verification failed, proceeding with stored fee', { poolFeeTier: this.settings.poolFeeTier, error: (e as Error).message });
      }
    }

    // Check token swap gate
    if (chain === 'bsc' || chain === 'ethereum') {
      try {
        const provider = getChainProvider(chain);
        const tokenGateAbi = [
          'function isSwapGateOpen() view returns (bool)',
          'function pools(address) view returns (bool)',
        ];
        const tok = new ethers.Contract(tokenAddress, tokenGateAbi, provider);
        const gateOpen: boolean = await tok.isSwapGateOpen();
        const poolRegistered: boolean = pairAddress ? await tok.pools(pairAddress) : false;
        if (!gateOpen) {
          logger.warn('⚠️  Token swap gate is CLOSED — call openSwapGate() on the token contract or all trades will revert', { token: tokenAddress });
        } else {
          logger.info('Token swap gate is open', { token: tokenAddress });
        }
        if (pairAddress && !poolRegistered) {
          logger.warn('⚠️  Pool address is NOT registered in token contract — transfers to this pool may be blocked', { pool: pairAddress });
        }
      } catch {
        // Token doesn't have isSwapGateOpen — normal ERC20, no check needed
      }
    }

    this.state = mode;
    this.monitor.on('price', this._onPrice);
    this.monitor.start(this.settings.chain, 15_000);
    if (mode === 'AUTO_TRADE') this._startVolumeLoop();
    logger.info('PegMaintainer started', { slot: this.slot, mode, chain: this.settings.chain, poolFeeTier: this.settings.poolFeeTier });
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  stop(): void {
    this.state = 'STOPPED';
    this.monitor.removeListener('price', this._onPrice);
    this.monitor.stop();
    this._stopVolumeLoop();
    logger.info('PegMaintainer stopped', { slot: this.slot });
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  pause(): void {
    if (this.state === 'STOPPED') return;
    this.state = 'PAUSED';
    this._stopVolumeLoop();
    logger.warn('PegMaintainer PAUSED', { slot: this.slot });
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.state = 'AUTO_TRADE';
    this._startVolumeLoop();
    logger.info('PegMaintainer resumed', { slot: this.slot });
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  private async saveState(): Promise<void> {
    try {
      await query(
        `INSERT INTO bot_state (id, mode, settings, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (id) DO UPDATE
           SET mode = EXCLUDED.mode, settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
        [this.slot + 1, this.state, JSON.stringify(this.settings)]
      );
    } catch { /* non-fatal */ }
  }

  async restoreState(): Promise<void> {
    try {
      const rows = await query<{ mode: string; settings: unknown }>(
        'SELECT mode, settings FROM bot_state WHERE id = $1', [this.slot + 1]
      );
      if (!rows.length) return;
      const { mode, settings: saved } = rows[0];
      if (saved && typeof saved === 'object') {
        this.settings = { ...this.settings, ...(saved as Partial<PegSettings>) };
      }
      if (mode !== 'MONITOR_ONLY' && mode !== 'AUTO_TRADE') return;
      logger.info('[PegMaintainer] Restoring persisted bot state', { slot: this.slot, mode });
      try {
        await this.start(mode as 'MONITOR_ONLY' | 'AUTO_TRADE');
      } catch (e: unknown) {
        logger.error('[PegMaintainer] Auto-restart failed', { slot: this.slot, error: (e as Error).message });
      }
    } catch (e: unknown) {
      logger.error('[PegMaintainer] Failed to read persisted state', { slot: this.slot, error: (e as Error).message });
    }
  }

  private _validateSettings(): void {
    const { chain, tokenAddress, stableAddress, pairAddress } = this.settings;
    if (!tokenAddress)  throw new Error(`Token address not set for ${chain}`);
    if (!stableAddress) throw new Error(`Stable address not set for ${chain}`);
    if (chain === 'bsc' || chain === 'ethereum') {
      if (!pairAddress)
        throw new Error(`Pair address not set for ${chain}. Use "Find Existing Pair" or enter your pool address.`);
    }
    if (chain === 'solana' && !pairAddress) {
      logger.warn('Solana pool address not set — price monitoring uses Jupiter quotes only, reserves will be 0');
    }
  }

  // ── Volume generation loop ─────────────────────────────────────────────────

  private _startVolumeLoop(): void {
    if (!this.settings.volumeEnabled || this._volumeTimer) return;
    const ms = this.settings.volumeIntervalSeconds * 1000;
    this._volumeTimer = setInterval(async () => {
      if (this.state !== 'AUTO_TRADE') return;
      const snap = this.monitor.getLastSnapshot();
      if (!snap) return;
      try { await this._executeVolumeSwap(snap); }
      catch (e: unknown) { logger.warn('Volume swap failed', { slot: this.slot, error: (e as Error).message }); }
    }, ms);
    logger.info('Volume loop started', { slot: this.slot, intervalMs: ms, sizeUsd: this.settings.volumeSwapSizeUsd });
  }

  private _stopVolumeLoop(): void {
    if (this._volumeTimer) { clearInterval(this._volumeTimer); this._volumeTimer = null; }
  }

  private async _executeVolumeSwap(snap: PriceSnapshot): Promise<void> {
    const { chain, slippageTolerance, volumeSwapSizeUsd, tokenAddress, stableAddress } = this.settings;
    const action = this._volumeDirection;

    // ── Solana volume swap ─────────────────────────────────────────────────────
    if (chain === 'solana') {
      const connection = getSolanaConnection();
      const keypair    = getSolanaKeypair();

      if (action === 'BUY') {
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(stableAddress), keypair.publicKey);
          const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
          const have = bal.value.uiAmount ?? 0;
          if (have < volumeSwapSizeUsd * 0.99) {
            logger.warn('Volume BUY skipped — insufficient stable', { have: have.toFixed(4), need: volumeSwapSizeUsd });
            return;
          }
        } catch { return; }
      } else {
        const tokenNeeded = snap.price > 0 ? volumeSwapSizeUsd / snap.price : 0;
        if (tokenNeeded <= 0) { this._volumeDirection = 'BUY'; return; }
        try {
          const ata = getAssociatedTokenAddressSync(new PublicKey(tokenAddress), keypair.publicKey);
          const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
          const have = bal.value.uiAmount ?? 0;
          if (have < tokenNeeded * 0.99) {
            logger.warn('Volume SELL skipped — insufficient token, resetting to BUY', { have: have.toFixed(6), need: tokenNeeded.toFixed(6) });
            this._volumeDirection = 'BUY';
            return;
          }
        } catch { this._volumeDirection = 'BUY'; return; }
      }

      const amount = action === 'BUY'
        ? volumeSwapSizeUsd
        : snap.price > 0 ? volumeSwapSizeUsd / snap.price : 0;
      if (amount <= 0) return;

      const rec: TradeRecord = {
        timestamp: new Date(), action, chain: 'solana',
        tokenAmount: 0, stableAmount: 0,
        priceBefore: snap.price, priceAfter: null,
        txHash: null, status: 'PENDING', isVolumeTrade: true,
      };

      try {
        await this._executeSolanaTrade(action, amount, snap, slippageTolerance, rec);
        this._volumeDirection = action === 'BUY' ? 'SELL' : 'BUY';
        logger.info('Solana volume swap done', { action, amount, txHash: rec.txHash });
      } catch (e: unknown) {
        rec.status = 'FAILED';
        rec.error  = (e as Error).message;
        logger.warn('Solana volume swap failed — retrying same direction next tick', { action, error: rec.error });
      }

      await this._saveRecord(rec);
      this.emit('trade', rec);
      return;
    }

    // ── EVM volume swap ────────────────────────────────────────────────────────
    const evmChain = chain as 'bsc' | 'ethereum';

    const signer   = getChainSigner(evmChain);
    const provider = signer.provider!;
    const balAbi   = [
      'function balanceOf(address) view returns (uint256)',
      'function decimals()         view returns (uint8)',
    ];

    if (action === 'BUY') {
      try {
        const c = new ethers.Contract(stableAddress, balAbi, provider);
        const [bal, dec] = await Promise.all([c.balanceOf(signer.address), c.decimals()]);
        const have = parseFloat(ethers.formatUnits(bal, Number(dec)));
        if (have < volumeSwapSizeUsd * 0.99) {
          logger.warn('Volume BUY skipped — insufficient stable', { have: have.toFixed(4), need: volumeSwapSizeUsd });
          return;
        }
      } catch { /* non-fatal */ }
    } else {
      const tokenNeeded = snap.price > 0 ? volumeSwapSizeUsd / snap.price : 0;
      if (tokenNeeded <= 0) { this._volumeDirection = 'BUY'; return; }
      try {
        const c = new ethers.Contract(tokenAddress, balAbi, provider);
        const [bal, dec] = await Promise.all([c.balanceOf(signer.address), c.decimals()]);
        const have = parseFloat(ethers.formatUnits(bal, Number(dec)));
        if (have < tokenNeeded * 0.99) {
          logger.warn('Volume SELL skipped — insufficient token, resetting to BUY', {
            have: have.toFixed(6), need: tokenNeeded.toFixed(6),
          });
          this._volumeDirection = 'BUY';
          return;
        }
      } catch { /* non-fatal */ }
    }

    const maxUsd = snap.liquidityUsd > 0 ? snap.liquidityUsd * 0.05 : volumeSwapSizeUsd;
    const cappedUsd = Math.min(volumeSwapSizeUsd, maxUsd);
    if (cappedUsd < volumeSwapSizeUsd) {
      logger.warn('Volume swap size capped to pool depth', {
        configured: volumeSwapSizeUsd, capped: cappedUsd.toFixed(4), liquidityUsd: snap.liquidityUsd,
      });
    }

    const amount = action === 'BUY'
      ? cappedUsd
      : snap.price > 0 ? cappedUsd / snap.price : 0;

    if (amount <= 0) return;

    const rec: TradeRecord = {
      timestamp: new Date(), action, chain: chain as PegChain,
      tokenAmount: 0, stableAmount: 0,
      priceBefore: snap.price, priceAfter: null,
      txHash: null, status: 'PENDING', isVolumeTrade: true,
    };

    try {
      await this._executeEvmTrade(evmChain, action, amount, snap, slippageTolerance, rec);
      this._volumeDirection = action === 'BUY' ? 'SELL' : 'BUY';
      logger.info('Volume swap done', { action, amount, txHash: rec.txHash });
    } catch (e: unknown) {
      rec.status = 'FAILED';
      rec.error  = (e as Error).message;
      logger.warn('Volume swap failed — retrying same direction next tick', { action, error: rec.error });
    }

    await this._saveRecord(rec);
    this.emit('trade', rec);
  }

  // ── Price handler ──────────────────────────────────────────────────────────

  private _onPrice = async (snap: PriceSnapshot): Promise<void> => {
    const { targetPeg, upperBand, lowerBand } = this.settings;
    const upper = targetPeg * (1 + upperBand);
    const lower = targetPeg * (1 - lowerBand);

    logger.info('Price check', { slot: this.slot, chain: snap.chain, price: snap.price.toFixed(6), state: this.state });
    this.emit('priceUpdate', { snapshot: snap, upper, lower });

    if (this.state !== 'AUTO_TRADE') return;
    if (snap.price > upper) await this._evalSell(snap);
    else if (snap.price < lower) await this._evalBuy(snap);
  };

  private _checkSafety(type: 'BUY' | 'SELL', amountUsd: number, snap: PriceSnapshot): string | null {
    if (this.state === 'PAUSED') return 'Bot is paused';
    if (snap.liquidityUsd > 0 && snap.liquidityUsd < this.settings.minLiquidityUsd)
      return `Liquidity $${snap.liquidityUsd.toFixed(0)} < min $${this.settings.minLiquidityUsd}`;
    if (this.lastTradeAt) {
      const secs = (Date.now() - this.lastTradeAt.getTime()) / 1000;
      if (secs < this.settings.cooldownSeconds)
        return `Cooldown: ${Math.ceil(this.settings.cooldownSeconds - secs)}s left`;
    }
    this._resetDailyIfNeeded();
    if (type === 'BUY' && this.dailySpendUsd + amountUsd > this.settings.maxDailySpendUsd)
      return `Daily limit: $${this.dailySpendUsd.toFixed(2)} + $${amountUsd.toFixed(2)} > $${this.settings.maxDailySpendUsd}`;
    return null;
  }

  private _resetDailyIfNeeded(): void {
    const now = new Date();
    if (now.getUTCDate() !== this.dailySpendResetAt.getUTCDate()) {
      this.dailySpendUsd = 0; this.dailySpendResetAt = now;
    }
  }

  private async _evalSell(snap: PriceSnapshot): Promise<void> {
    const { targetPeg, maxTradeSizeTokens, slippageTolerance } = this.settings;
    const ideal  = this.monitor.calcSellAmount(snap, targetPeg);
    const amount = this.monitor.getPoolVersion() === 'v3' || ideal <= 0
      ? maxTradeSizeTokens
      : Math.min(ideal, maxTradeSizeTokens);
    const blocked = this._checkSafety('SELL', amount * snap.price, snap);
    if (blocked) { logger.info('SELL blocked', { reason: blocked }); return; }
    await this._executeTrade('SELL', amount, snap, slippageTolerance);
  }

  private async _evalBuy(snap: PriceSnapshot): Promise<void> {
    const { targetPeg, maxTradeSizeTokens, maxDailySpendUsd, slippageTolerance } = this.settings;
    const maxUsd = Math.min(maxTradeSizeTokens * targetPeg, maxDailySpendUsd - this.dailySpendUsd);
    const ideal  = this.monitor.calcBuyAmount(snap, targetPeg);
    const amount = this.monitor.getPoolVersion() === 'v3' || ideal <= 0
      ? maxUsd
      : Math.min(ideal, maxUsd);
    const blocked = this._checkSafety('BUY', amount, snap);
    if (blocked) { logger.info('BUY blocked', { reason: blocked }); return; }
    await this._executeTrade('BUY', amount, snap, slippageTolerance);
  }

  private async _executeTrade(
    action: 'BUY' | 'SELL', amount: number, snap: PriceSnapshot, slippage: number
  ): Promise<void> {
    const { chain } = this.settings;
    const rec: TradeRecord = {
      timestamp: new Date(), action, chain,
      tokenAmount: 0, stableAmount: 0,
      priceBefore: snap.price, priceAfter: null,
      txHash: null, status: 'PENDING',
    };
    try {
      if (chain === 'solana') await this._executeSolanaTrade(action, amount, snap, slippage, rec);
      else await this._executeEvmTrade(chain, action, amount, snap, slippage, rec);
    } catch (e: unknown) {
      rec.status = 'FAILED';
      rec.error  = (e as Error).message;
      logger.error('Trade failed', { chain, action, error: rec.error });
    }
    await this._saveRecord(rec);
    this.emit('trade', rec);
  }

  // ── EVM trade via KyberSwap DEX aggregator ────────────────────────────────

  private async _executeEvmTrade(
    chain: 'bsc' | 'ethereum',
    action: 'BUY' | 'SELL',
    amount: number,
    snap: PriceSnapshot,
    slippage: number,
    rec: TradeRecord
  ): Promise<void> {
    const { tokenAddress, stableAddress } = this.settings;
    const signer    = getChainSigner(chain);
    const provider  = signer.provider!;
    const overrides = await txOverrides(chain);

    const erc20Dec = ['function decimals() view returns (uint8)'];
    const [tokenDec, stableDec] = await Promise.all([
      Number(await new ethers.Contract(tokenAddress,  erc20Dec, provider).decimals()),
      Number(await new ethers.Contract(stableAddress, erc20Dec, provider).decimals()),
    ]);

    const sellToken  = action === 'SELL' ? tokenAddress  : stableAddress;
    const buyToken   = action === 'SELL' ? stableAddress : tokenAddress;
    const sellDec    = action === 'SELL' ? tokenDec      : stableDec;
    const buyDec     = action === 'SELL' ? stableDec     : tokenDec;
    const sellAmount = ethers.parseUnits(amount.toFixed(sellDec), sellDec);

    const KYBER_BASE: Record<'bsc' | 'ethereum', string> = {
      bsc:      'https://aggregator-api.kyberswap.com/bsc',
      ethereum: 'https://aggregator-api.kyberswap.com/ethereum',
    };
    const base = KYBER_BASE[chain];
    const slippageBps = Math.round(slippage * 10000);

    logger.info('KyberSwap: fetching route', { chain, action, sellToken, buyToken, sellAmount: sellAmount.toString() });
    const routeRes = await fetch(
      `${base}/api/v1/routes?tokenIn=${sellToken}&tokenOut=${buyToken}&amountIn=${sellAmount.toString()}`,
      { headers: { 'User-Agent': 'pegbot/1.0' } },
    );
    if (!routeRes.ok) throw new Error(`KyberSwap route error (${routeRes.status}): ${await routeRes.text()}`);
    const routeJson = await routeRes.json() as { code: number; message: string; data: { routeSummary: unknown; routerAddress: string } };
    if (routeJson.code !== 0) throw new Error(`KyberSwap route failed: ${routeJson.message}`);
    const { routeSummary, routerAddress } = routeJson.data;
    logger.info('KyberSwap: route found', { chain, action, routerAddress });

    const buildRes = await fetch(`${base}/api/v1/route/build`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'pegbot/1.0', 'Origin': 'https://kyberswap.com' },
      body: JSON.stringify({
        routeSummary,
        sender:            signer.address,
        recipient:         signer.address,
        slippageTolerance: slippageBps,
      }),
    });
    if (!buildRes.ok) throw new Error(`KyberSwap build error (${buildRes.status}): ${await buildRes.text()}`);
    const buildJson = await buildRes.json() as { code: number; message: string; data: { data: string; amountOut: string; routerAddress: string } };
    if (buildJson.code !== 0) throw new Error(`KyberSwap build failed: ${buildJson.message}`);
    const { data: txData, amountOut, routerAddress: txRouter } = buildJson.data;
    logger.info('KyberSwap: tx built', { chain, action, amountOut, router: txRouter });

    const spender = txRouter || routerAddress;
    await ensureApproval(sellToken, spender, sellAmount, chain);

    const tx = await signer.sendTransaction({
      to:    spender,
      data:  txData,
      value: 0n,
      ...overrides,
    });
    rec.txHash = tx.hash;
    logger.info('KyberSwap swap submitted', { chain, action, txHash: tx.hash });
    await tx.wait();

    const bought = parseFloat(ethers.formatUnits(amountOut ?? '0', buyDec));
    if (action === 'SELL') {
      rec.tokenAmount  = amount;
      rec.stableAmount = bought;
    } else {
      rec.stableAmount = amount;
      rec.tokenAmount  = bought;
    }

    const after = await this.monitor.getPrice(chain);
    rec.priceAfter = after.price;
    rec.status     = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('0x swap confirmed', { chain, action, txHash: tx.hash });
  }

  // ── Solana trade (via Jupiter) ─────────────────────────────────────────────

  private async _executeSolanaTrade(
    action: 'BUY' | 'SELL',
    amount: number,
    snap: PriceSnapshot,
    slippage: number,
    rec: TradeRecord
  ): Promise<void> {
    const { tokenAddress: tokenMint, stableAddress: stableMint } = this.settings;
    const connection  = getSolanaConnection();
    const keypair     = getSolanaKeypair();
    const slippageBps = Math.round(slippage * 10_000);

    const [tokenDec, stableDec] = await Promise.all([
      getMintDecimals(connection, new PublicKey(tokenMint)),
      getMintDecimals(connection, new PublicKey(stableMint)),
    ]);

    const amountRaw = action === 'SELL'
      ? BigInt(Math.round(amount * 10 ** tokenDec))
      : BigInt(Math.round(amount * 10 ** stableDec));

    const { txSignature, outputAmount } = await executeJupiterSwap({
      direction: action, amountRaw, tokenMint, stableMint,
      slippageBps, connection, keypair,
    });

    rec.txHash = txSignature;
    if (action === 'SELL') {
      rec.tokenAmount  = amount;
      rec.stableAmount = Number(outputAmount) / 10 ** stableDec;
    } else {
      rec.stableAmount = amount;
      rec.tokenAmount  = Number(outputAmount) / 10 ** tokenDec;
    }

    const after = await this.monitor.getPrice('solana');
    rec.priceAfter = after.price;
    rec.status     = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('Solana trade confirmed', { action, sig: txSignature.slice(0, 16) });
  }

  // ── Pool management ────────────────────────────────────────────────────────

  async resolveFromPair(pairAddress: string, chain: 'bsc' | 'ethereum'): Promise<{
    token0: string; token1: string; fee: number; dexVersion: 'v2' | 'v3';
  }> {
    const provider = getChainSigner(chain).provider!;

    try {
      const pool = new ethers.Contract(pairAddress, V3_POOL_ABI, provider);
      const [token0, token1, fee] = await Promise.all([
        pool.token0() as Promise<string>,
        pool.token1() as Promise<string>,
        pool.fee()    as Promise<bigint>,
      ]);
      return { token0, token1, fee: Number(fee), dexVersion: 'v3' };
    } catch { /* not V3 */ }

    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [token0, token1] = await Promise.all([
      pair.token0() as Promise<string>,
      pair.token1() as Promise<string>,
    ]);
    return { token0, token1, fee: 0, dexVersion: 'v2' };
  }

  async findPair(): Promise<string | null> {
    const { chain, tokenAddress, stableAddress } = this.settings;

    if (chain === 'solana') {
      if (!tokenAddress || !stableAddress) return null;
      const { findSolanaPool } = await import('../solana/raydiumPool');
      return findSolanaPool(tokenAddress, stableAddress);
    }

    if (!tokenAddress || !stableAddress) return null;
    const provider  = getChainSigner(chain).provider!;
    const factory   = new ethers.Contract(CHAIN_TOKENS[chain].factory, V3_FACTORY_ABI, provider);

    for (const fee of V3_FEE_TIERS) {
      try {
        const pool: string = await factory.getPool(tokenAddress, stableAddress, fee);
        if (pool && pool !== ethers.ZeroAddress) {
          this.settings.poolFeeTier = fee;
          return pool;
        }
      } catch { /* try next */ }
    }
    return null;
  }

  // ── DB helpers ─────────────────────────────────────────────────────────────

  private async _saveRecord(rec: TradeRecord): Promise<void> {
    try {
      await ensureSlotColumn();
      await query(
        `INSERT INTO peg_trades
           (timestamp,action,chain,token_amount,stable_amount,price_before,price_after,tx_hash,status,error_message,is_volume_trade,slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [rec.timestamp, rec.action, rec.chain, rec.tokenAmount, rec.stableAmount,
         rec.priceBefore, rec.priceAfter, rec.txHash, rec.status, rec.error ?? null,
         rec.isVolumeTrade ?? false, this.slot]
      );
    } catch { /* non-fatal */ }
  }

  async getTradeHistory(limit = 50, offset = 0): Promise<TradeRecord[]> {
    await ensureSlotColumn();
    return query<TradeRecord>(
      `SELECT * FROM peg_trades WHERE slot = $3 ORDER BY timestamp DESC LIMIT $1 OFFSET $2`,
      [limit, offset, this.slot]
    );
  }

  async getDailyStats() {
    await ensureSlotColumn();
    const rows = await query<{
      total_trades: string; total_buy_usd: string; total_sell_tokens: string;
      volume_trades: string; volume_usd: string;
    }>(
      `SELECT
         COUNT(*)                                                                    AS total_trades,
         COALESCE(SUM(CASE WHEN action='BUY'  AND NOT is_volume_trade THEN stable_amount END),0) AS total_buy_usd,
         COALESCE(SUM(CASE WHEN action='SELL' AND NOT is_volume_trade THEN token_amount  END),0) AS total_sell_tokens,
         COUNT(*) FILTER (WHERE is_volume_trade)                                    AS volume_trades,
         COALESCE(SUM(CASE WHEN is_volume_trade THEN stable_amount END),0)          AS volume_usd
       FROM peg_trades
       WHERE timestamp > NOW()-INTERVAL '24 hours' AND status='SUCCESS' AND slot = $1`,
      [this.slot]
    );
    const r = rows[0];
    return {
      totalTrades:     parseInt(r?.total_trades    ?? '0'),
      totalBuyUsd:     parseFloat(r?.total_buy_usd ?? '0'),
      totalSellTokens: parseFloat(r?.total_sell_tokens ?? '0'),
      volumeTrades:    parseInt(r?.volume_trades   ?? '0'),
      volumeUsd:       parseFloat(r?.volume_usd    ?? '0'),
    };
  }

  // Expose the monitor for SSE subscriptions
  getMonitor(): PriceMonitor { return this.monitor; }
}

// ── Multi-slot singletons ──────────────────────────────────────────────────
declare global { var __pegSlots: (PegMaintainer | undefined)[] | undefined }

export function getPegSlot(slot: number): PegMaintainer {
  if (!global.__pegSlots) global.__pegSlots = [];
  if (!global.__pegSlots[slot]) {
    const monitor = getPriceMonitorSlot(slot);
    global.__pegSlots[slot] = new PegMaintainer(slot, monitor);
  }
  return global.__pegSlots[slot]!;
}

// Backward-compat alias for slot 0
export const pegMaintainer: PegMaintainer = getPegSlot(0);
