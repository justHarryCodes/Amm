import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { priceMonitor, PriceSnapshot } from './priceMonitor';
import { getChainSigner, getChainProvider, getGasPrice } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { getSolanaConnection, getSolanaKeypair } from '../solana/connection';
import { getMintDecimals } from '../solana/splTransfer';
import { executeJupiterSwap } from '../solana/jupiterPeg';
import { PublicKey } from '@solana/web3.js';

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

class PegMaintainer extends EventEmitter {
  state: BotState = 'STOPPED';
  settings: PegSettings = initialSettings();

  lastTradeAt: Date | null = null;
  dailySpendUsd = 0;
  private dailySpendResetAt = new Date();

  private _volumeTimer: ReturnType<typeof setInterval> | null = null;
  private _volumeDirection: 'BUY' | 'SELL' = 'BUY';

  updateSettings(partial: Partial<PegSettings>): void {
    if (partial.chain && partial.chain !== this.settings.chain) {
      if (this.state !== 'STOPPED') throw new Error('Stop the bot before changing chain');
      this.settings = { ...this.settings, ...chainDefaults(partial.chain), ...partial };
    } else {
      this.settings = { ...this.settings, ...partial };
    }
    logger.info('Peg settings updated', { chain: this.settings.chain, token: this.settings.tokenAddress.slice(0, 10) });

    // Live-toggle volume loop when bot is already running
    if (this.state === 'AUTO_TRADE') {
      if (this.settings.volumeEnabled && !this._volumeTimer) {
        // Settings just enabled volume — restart loop with new interval
        this._startVolumeLoop();
      } else if (!this.settings.volumeEnabled && this._volumeTimer) {
        // Settings just disabled volume
        this._stopVolumeLoop();
      } else if (this.settings.volumeEnabled && this._volumeTimer && partial.volumeIntervalSeconds) {
        // Interval changed while running — restart with new interval
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
    try { await priceMonitor.initialize(this.settings); }
    catch (e: unknown) { throw new Error(`PriceMonitor init failed: ${(e as Error).message}`); }

    // For V3 pools: verify the pool is registered in the official factory so the
    // SmartRouter can find it. The SmartRouter derives the pool address from
    // (factory, tokenA, tokenB, fee) — if the pool wasn't deployed through the
    // official factory, that lookup fails and every swap reverts.
    const { chain, pairAddress, tokenAddress, stableAddress } = this.settings;
    if ((chain === 'bsc' || chain === 'ethereum') && pairAddress && priceMonitor.getPoolVersion() === 'v3') {
      try {
        const provider  = getChainProvider(chain);
        const factory   = new ethers.Contract(CHAIN_TOKENS[chain].factory, V3_FACTORY_ABI, provider);

        // 1. Read fee from the pool contract itself
        const pool    = new ethers.Contract(pairAddress, V3_POOL_ABI, provider);
        const poolFee = Number(await pool.fee());

        // 2. Confirm the factory agrees — i.e. the SmartRouter will find this pool
        const factoryPool = poolFee
          ? String(await factory.getPool(tokenAddress, stableAddress, poolFee))
          : ethers.ZeroAddress;
        const factoryKnows = factoryPool.toLowerCase() === pairAddress.toLowerCase();

        if (factoryKnows && poolFee) {
          logger.info('V3 pool verified via factory', { fee: poolFee, pool: pairAddress });
          this.settings.poolFeeTier = poolFee;
        } else {
          // Factory doesn't recognise the pool at that fee — scan all tiers
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

    // Check token swap gate — some custom tokens require openSwapGate() to be
    // called by the owner before any router swap can go through.
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
    priceMonitor.on('price', this._onPrice);
    priceMonitor.start(this.settings.chain, 15_000);
    if (mode === 'AUTO_TRADE') this._startVolumeLoop();
    logger.info('PegMaintainer started', { mode, chain: this.settings.chain, poolFeeTier: this.settings.poolFeeTier });
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  stop(): void {
    this.state = 'STOPPED';
    priceMonitor.removeListener('price', this._onPrice);
    priceMonitor.stop();
    this._stopVolumeLoop();
    logger.info('PegMaintainer stopped');
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  pause(): void {
    if (this.state === 'STOPPED') return;
    this.state = 'PAUSED';
    this._stopVolumeLoop();
    logger.warn('PegMaintainer PAUSED');
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.state = 'AUTO_TRADE';
    this._startVolumeLoop();
    logger.info('PegMaintainer resumed');
    this.emit('stateChange', this.state);
    void this.saveState();
  }

  private async saveState(): Promise<void> {
    try {
      await query(
        `INSERT INTO bot_state (id, mode, settings, updated_at)
         VALUES (1, $1, $2, NOW())
         ON CONFLICT (id) DO UPDATE
           SET mode = EXCLUDED.mode, settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at`,
        [this.state, JSON.stringify(this.settings)]
      );
    } catch { /* non-fatal */ }
  }

  async restoreState(): Promise<void> {
    try {
      const rows = await query<{ mode: string; settings: unknown }>(
        'SELECT mode, settings FROM bot_state WHERE id = 1'
      );
      if (!rows.length) return;
      const { mode, settings: saved } = rows[0];
      if (saved && typeof saved === 'object') {
        this.settings = { ...this.settings, ...(saved as Partial<PegSettings>) };
      }
      if (mode !== 'MONITOR_ONLY' && mode !== 'AUTO_TRADE') return;
      logger.info('[PegMaintainer] Restoring persisted bot state', { mode });
      try {
        await this.start(mode as 'MONITOR_ONLY' | 'AUTO_TRADE');
      } catch (e: unknown) {
        logger.error('[PegMaintainer] Auto-restart failed', { error: (e as Error).message });
      }
    } catch (e: unknown) {
      logger.error('[PegMaintainer] Failed to read persisted state', { error: (e as Error).message });
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
  }

  // ── Volume generation loop ─────────────────────────────────────────────────

  private _startVolumeLoop(): void {
    if (!this.settings.volumeEnabled || this._volumeTimer) return;
    const ms = this.settings.volumeIntervalSeconds * 1000;
    this._volumeTimer = setInterval(async () => {
      if (this.state !== 'AUTO_TRADE') return;
      const snap = priceMonitor.getLastSnapshot();
      if (!snap) return;
      try { await this._executeVolumeSwap(snap); }
      catch (e: unknown) { logger.warn('Volume swap failed', { error: (e as Error).message }); }
    }, ms);
    logger.info('Volume loop started', { intervalMs: ms, sizeUsd: this.settings.volumeSwapSizeUsd });
  }

  private _stopVolumeLoop(): void {
    if (this._volumeTimer) { clearInterval(this._volumeTimer); this._volumeTimer = null; }
  }

  private async _executeVolumeSwap(snap: PriceSnapshot): Promise<void> {
    const { chain, slippageTolerance, volumeSwapSizeUsd, tokenAddress, stableAddress } = this.settings;
    if (chain === 'solana') return;

    const evmChain = chain as 'bsc' | 'ethereum';
    const action   = this._volumeDirection;

    // Pre-flight balance check — abort if the bot can't cover this swap
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
          return; // Keep direction as BUY — retry next tick once wallet is funded
        }
      } catch { /* non-fatal — let the trade attempt and fail with its own error */ }
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
          this._volumeDirection = 'BUY'; // Reset so next tick buys tokens first
          return;
        }
      } catch { /* non-fatal */ }
    }

    // Cap swap to 5 % of single-sided pool depth so we never exhaust the active
    // tick range in a concentrated-liquidity (V3) pool.
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
      // Only flip direction after a confirmed successful swap
      this._volumeDirection = action === 'BUY' ? 'SELL' : 'BUY';
      logger.info('Volume swap done', { action, amount, txHash: rec.txHash });
    } catch (e: unknown) {
      rec.status = 'FAILED';
      rec.error  = (e as Error).message;
      logger.warn('Volume swap failed — retrying same direction next tick', { action, error: rec.error });
      // Direction unchanged — retry same side next tick
    }

    await this._saveRecord(rec);
    this.emit('trade', rec);
  }

  // ── Price handler ──────────────────────────────────────────────────────────

  private _onPrice = async (snap: PriceSnapshot): Promise<void> => {
    const { targetPeg, upperBand, lowerBand } = this.settings;
    const upper = targetPeg * (1 + upperBand);
    const lower = targetPeg * (1 - lowerBand);

    logger.info('Price check', { chain: snap.chain, price: snap.price.toFixed(6), state: this.state });
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
    const amount  = Math.min(priceMonitor.calcSellAmount(snap, targetPeg), maxTradeSizeTokens);
    const blocked = this._checkSafety('SELL', amount * snap.price, snap);
    if (blocked) { logger.info('SELL blocked', { reason: blocked }); return; }
    await this._executeTrade('SELL', amount, snap, slippageTolerance);
  }

  private async _evalBuy(snap: PriceSnapshot): Promise<void> {
    const { targetPeg, maxTradeSizeTokens, maxDailySpendUsd, slippageTolerance } = this.settings;
    const amount  = Math.min(
      priceMonitor.calcBuyAmount(snap, targetPeg),
      maxTradeSizeTokens * snap.price,
      maxDailySpendUsd - this.dailySpendUsd,
    );
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

  // ── EVM trade — auto-detects V2 vs V3 and routes accordingly ──────────────

  private async _executeEvmTrade(
    chain: 'bsc' | 'ethereum',
    action: 'BUY' | 'SELL',
    amount: number,
    snap: PriceSnapshot,
    slippage: number,
    rec: TradeRecord
  ): Promise<void> {
    const { tokenAddress, stableAddress, pairAddress } = this.settings;
    let { poolFeeTier } = this.settings;
    const signer   = getChainSigner(chain);
    const provider = signer.provider!;
    const overrides = await txOverrides(chain);

    const erc20Dec = ['function decimals() view returns (uint8)'];
    const erc20Allowance = [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ];

    const [tokenDec, stableDec] = await Promise.all([
      Number(await new ethers.Contract(tokenAddress,  erc20Dec, provider).decimals()),
      Number(await new ethers.Contract(stableAddress, erc20Dec, provider).decimals()),
    ]);

    const deadline   = Math.floor(Date.now() / 1000) + 300;
    const poolVer    = priceMonitor.getPoolVersion();

    let tx: { hash: string; wait: () => Promise<unknown> };

    if (poolVer === 'v2') {
      // ── V2 swap (PancakeSwap V2 / Uniswap V2) ──────────────────────────────
      const V2_ROUTER: Record<'bsc' | 'ethereum', string> = {
        bsc:      '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        ethereum: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      };
      const V2_ABI = [
        'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
        'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
      ];
      const v2Router    = new ethers.Contract(V2_ROUTER[chain], V2_ABI, signer);
      const v2RouterAddr = V2_ROUTER[chain];

      if (action === 'SELL') {
        const amtIn = ethers.parseUnits(amount.toFixed(tokenDec), tokenDec);
        const tok = new ethers.Contract(tokenAddress, erc20Allowance, signer);
        if ((await tok.allowance(signer.address, v2RouterAddr)) < amtIn) {
          const t = await tok.approve(v2RouterAddr, ethers.MaxUint256, overrides); await t.wait();
        }
        tx = await v2Router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amtIn, 0n, [tokenAddress, stableAddress], signer.address, deadline, overrides,
        );
        rec.tokenAmount  = amount;
        rec.stableAmount = amount * snap.price;
      } else {
        const amtIn = ethers.parseUnits(amount.toFixed(stableDec), stableDec);
        const stb = new ethers.Contract(stableAddress, erc20Allowance, signer);
        if ((await stb.allowance(signer.address, v2RouterAddr)) < amtIn) {
          const t = await stb.approve(v2RouterAddr, ethers.MaxUint256, overrides); await t.wait();
        }
        tx = await v2Router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
          amtIn, 0n, [stableAddress, tokenAddress], signer.address, deadline, overrides,
        );
        rec.stableAmount = amount;
        rec.tokenAmount  = snap.price > 0 ? amount / snap.price : 0;
      }

      logger.info('EVM V2 trade submitted', { chain, action, txHash: tx.hash });
    } else {
      // ── V3 swap (PancakeSwap V3 / Uniswap V3) ──────────────────────────────
      // Auto-read fee tier from pool if not set in settings
      if (!poolFeeTier && pairAddress) {
        try {
          const pool = new ethers.Contract(pairAddress, V3_POOL_ABI, provider);
          poolFeeTier = Number(await pool.fee());
          this.settings.poolFeeTier = poolFeeTier; // cache for next trade
          logger.info('Auto-detected V3 pool fee', { fee: poolFeeTier });
        } catch {
          poolFeeTier = CHAIN_TOKENS[chain].defaultFeeTier;
        }
      }
      const fee          = poolFeeTier || CHAIN_TOKENS[chain].defaultFeeTier;
      const routerAddress = getRouter(chain);
      const routerAbi     = chain === 'bsc' ? PANCAKE_V3_ROUTER_ABI : UNISWAP_V3_ROUTER_ABI;
      const router        = new ethers.Contract(routerAddress, routerAbi, signer);

      await ensureApproval(tokenAddress,  routerAddress, ethers.MaxUint256, chain);
      await ensureApproval(stableAddress, routerAddress, ethers.MaxUint256, chain);

      if (action === 'SELL') {
        const amtIn = ethers.parseUnits(amount.toFixed(tokenDec), tokenDec);
        const params = chain === 'bsc'
          ? { tokenIn: tokenAddress, tokenOut: stableAddress, fee, recipient: signer.address, amountIn: amtIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }
          : { tokenIn: tokenAddress, tokenOut: stableAddress, fee, recipient: signer.address, deadline, amountIn: amtIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
        tx = await router.exactInputSingle(params, overrides);
        rec.tokenAmount  = amount;
        rec.stableAmount = amount * snap.price;
      } else {
        const amtIn = ethers.parseUnits(amount.toFixed(stableDec), stableDec);
        const params = chain === 'bsc'
          ? { tokenIn: stableAddress, tokenOut: tokenAddress, fee, recipient: signer.address, amountIn: amtIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }
          : { tokenIn: stableAddress, tokenOut: tokenAddress, fee, recipient: signer.address, deadline, amountIn: amtIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
        tx = await router.exactInputSingle(params, overrides);
        rec.stableAmount = amount;
        rec.tokenAmount  = snap.price > 0 ? amount / snap.price : 0;
      }

      logger.info('EVM V3 trade submitted', { chain, action, fee, txHash: tx.hash });
    }

    rec.txHash = tx.hash;
    await tx.wait();

    const after = await priceMonitor.getPrice(chain);
    rec.priceAfter = after.price;
    rec.status     = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('EVM trade confirmed', { chain, action, poolVer, txHash: tx.hash });
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

    const after = await priceMonitor.getPrice('solana');
    rec.priceAfter = after.price;
    rec.status     = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('Solana trade confirmed', { action, sig: txSignature.slice(0, 16) });
  }

  // ── Pool management ────────────────────────────────────────────────────────

  // Given a pair/pool address, return token0, token1, and fee (for V3)
  async resolveFromPair(pairAddress: string, chain: 'bsc' | 'ethereum'): Promise<{
    token0: string; token1: string; fee: number; dexVersion: 'v2' | 'v3';
  }> {
    const provider = getChainSigner(chain).provider!;

    // Probe for V3
    try {
      const pool = new ethers.Contract(pairAddress, V3_POOL_ABI, provider);
      const [token0, token1, fee] = await Promise.all([
        pool.token0() as Promise<string>,
        pool.token1() as Promise<string>,
        pool.fee()    as Promise<bigint>,
      ]);
      return { token0, token1, fee: Number(fee), dexVersion: 'v3' };
    } catch { /* not V3 */ }

    // Fall back to V2
    const pair = new ethers.Contract(pairAddress, V2_PAIR_ABI, provider);
    const [token0, token1] = await Promise.all([
      pair.token0() as Promise<string>,
      pair.token1() as Promise<string>,
    ]);
    return { token0, token1, fee: 0, dexVersion: 'v2' };
  }

  // Find existing V3 pool across all common fee tiers (or V2 pair as fallback)
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

    // Try V3 fee tiers in order of most common
    for (const fee of V3_FEE_TIERS) {
      try {
        const pool: string = await factory.getPool(tokenAddress, stableAddress, fee);
        if (pool && pool !== ethers.ZeroAddress) {
          // Update settings with discovered fee tier
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
      await query(
        `INSERT INTO peg_trades
           (timestamp,action,chain,token_amount,stable_amount,price_before,price_after,tx_hash,status,error_message,is_volume_trade)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [rec.timestamp, rec.action, rec.chain, rec.tokenAmount, rec.stableAmount,
         rec.priceBefore, rec.priceAfter, rec.txHash, rec.status, rec.error ?? null,
         rec.isVolumeTrade ?? false]
      );
    } catch { /* non-fatal */ }
  }

  async getTradeHistory(limit = 50, offset = 0): Promise<TradeRecord[]> {
    return query<TradeRecord>(
      `SELECT * FROM peg_trades ORDER BY timestamp DESC LIMIT $1 OFFSET $2`, [limit, offset]
    );
  }

  async getDailyStats() {
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
       WHERE timestamp > NOW()-INTERVAL '24 hours' AND status='SUCCESS'`
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
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __pegMaintainer: PegMaintainer | undefined }
export const pegMaintainer: PegMaintainer = global.__pegMaintainer ?? new PegMaintainer();
global.__pegMaintainer = pegMaintainer;
