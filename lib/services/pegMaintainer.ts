import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { priceMonitor, PriceSnapshot } from './priceMonitor';
import { getChainSigner, getGasPrice } from '../blockchain/provider';
import { config, PegChain } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { getSolanaConnection, getSolanaKeypair } from '../solana/connection';
import { getMintDecimals } from '../solana/splTransfer';
import { executeJupiterSwap } from '../solana/jupiterPeg';
import { PublicKey } from '@solana/web3.js';

import ROUTER_ABI  from '../abi/PancakeV2Router.json';
import FACTORY_ABI from '../abi/PancakeV2Factory.json';
import ERC20_ABI   from '../abi/ERC20.json';
import { txOverrides } from '../blockchain/contracts';

export type BotState = 'STOPPED' | 'MONITOR_ONLY' | 'AUTO_TRADE' | 'PAUSED';

export interface PegSettings {
  chain: PegChain;

  // ── Token configuration (fully UI-editable, any token on any chain) ───────
  tokenAddress:  string;  // EVM: 0x…  |  Solana: base58 mint
  stableAddress: string;  // EVM: 0x…  |  Solana: base58 stable mint (e.g. USDC)
  pairAddress:   string;  // EVM only: DEX pair contract (0x…)
  routerAddress: string;  // EVM only: Uniswap V2 / PancakeSwap V2 compatible router

  // ── Safety limits ─────────────────────────────────────────────────────────
  targetPeg:          number;
  upperBand:          number;
  lowerBand:          number;
  maxTradeSizeTokens: number;
  maxDailySpendUsd:   number;
  minLiquidityUsd:    number;
  cooldownSeconds:    number;
  slippageTolerance:  number;
}

export interface TradeRecord {
  id?: number; timestamp: Date; action: 'BUY' | 'SELL';
  chain: PegChain;
  tokenAmount: number; stableAmount: number;
  priceBefore: number; priceAfter: number | null;
  txHash: string | null; status: 'SUCCESS' | 'FAILED' | 'PENDING'; error?: string;
}

// Pull env-var defaults for a given chain (used as initial values and when chain changes)
function chainDefaults(chain: PegChain): Pick<PegSettings, 'tokenAddress' | 'stableAddress' | 'pairAddress' | 'routerAddress'> {
  if (chain === 'bsc') return {
    tokenAddress:  config.pegChains.bsc.tokenAddress,
    stableAddress: config.pegChains.bsc.stableAddress,
    pairAddress:   config.pegChains.bsc.pairAddress,
    routerAddress: config.pegChains.bsc.routerAddress,
  };
  if (chain === 'ethereum') return {
    tokenAddress:  config.pegChains.ethereum.tokenAddress,
    stableAddress: config.pegChains.ethereum.stableAddress,
    pairAddress:   config.pegChains.ethereum.pairAddress,
    routerAddress: config.pegChains.ethereum.routerAddress,
  };
  return {
    tokenAddress:  config.pegChains.solana.tokenMint,
    stableAddress: config.pegChains.solana.stableMint,
    pairAddress:   '',
    routerAddress: '',
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
  };
}

class PegMaintainer extends EventEmitter {
  state: BotState = 'STOPPED';
  settings: PegSettings = initialSettings();

  private lastTradeAt: Date | null = null;
  private dailySpendUsd = 0;
  private dailySpendResetAt = new Date();

  updateSettings(partial: Partial<PegSettings>): void {
    if (partial.chain && partial.chain !== this.settings.chain) {
      if (this.state !== 'STOPPED') throw new Error('Stop the bot before changing chain');
      // Switching chain: apply env defaults for the new chain, then override with anything provided
      this.settings = { ...this.settings, ...chainDefaults(partial.chain), ...partial };
    } else {
      this.settings = { ...this.settings, ...partial };
    }
    logger.info('Peg settings updated', { chain: this.settings.chain, token: this.settings.tokenAddress.slice(0, 10) });
    this.emit('stateChange', this.state);
  }

  async start(mode: 'MONITOR_ONLY' | 'AUTO_TRADE'): Promise<void> {
    if (this.state !== 'STOPPED') return;
    this._validateSettings();
    try { await priceMonitor.initialize(this.settings); }
    catch (e: unknown) { throw new Error(`PriceMonitor init failed: ${(e as Error).message}`); }
    this.state = mode;
    priceMonitor.on('price', this._onPrice);
    priceMonitor.start(this.settings.chain, 15_000);
    logger.info('PegMaintainer started', { mode, chain: this.settings.chain, token: this.settings.tokenAddress.slice(0, 10) });
    this.emit('stateChange', this.state);
  }

  stop(): void {
    this.state = 'STOPPED';
    priceMonitor.removeListener('price', this._onPrice);
    priceMonitor.stop();
    logger.info('PegMaintainer stopped');
    this.emit('stateChange', this.state);
  }

  pause(): void {
    if (this.state === 'STOPPED') return;
    this.state = 'PAUSED';
    logger.warn('PegMaintainer PAUSED');
    this.emit('stateChange', this.state);
  }

  resume(): void {
    if (this.state !== 'PAUSED') return;
    this.state = 'AUTO_TRADE';
    logger.info('PegMaintainer resumed');
    this.emit('stateChange', this.state);
  }

  private _validateSettings(): void {
    const { chain, tokenAddress, stableAddress, pairAddress, routerAddress } = this.settings;
    if (!tokenAddress)  throw new Error(`Token address not set for ${chain}`);
    if (!stableAddress) throw new Error(`Stable address not set for ${chain}`);
    if (chain === 'bsc' || chain === 'ethereum') {
      if (!routerAddress) throw new Error(`Router address not set for ${chain}`);
      if (!pairAddress)
        throw new Error(`Pair address not set for ${chain}. Use "Find Existing Pair" or "Create Pair & Add Initial Liquidity" in Settings.`);
    }
  }

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
    const amount = Math.min(priceMonitor.calcSellAmount(snap, targetPeg), maxTradeSizeTokens);
    const blocked = this._checkSafety('SELL', amount * snap.price, snap);
    if (blocked) { logger.info('SELL blocked', { reason: blocked }); return; }
    await this._executeTrade('SELL', amount, snap, slippageTolerance);
  }

  private async _evalBuy(snap: PriceSnapshot): Promise<void> {
    const { targetPeg, maxTradeSizeTokens, maxDailySpendUsd, slippageTolerance } = this.settings;
    const amount = Math.min(
      priceMonitor.calcBuyAmount(snap, targetPeg),
      maxTradeSizeTokens * snap.price,
      maxDailySpendUsd - this.dailySpendUsd
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

  // ── EVM trade ─────────────────────────────────────────────────────────────
  // Works on any Uniswap V2-compatible router (PancakeSwap V2, Uniswap V2, SushiSwap, etc.)

  private async _executeEvmTrade(
    chain: 'bsc' | 'ethereum',
    action: 'BUY' | 'SELL',
    amount: number,
    snap: PriceSnapshot,
    slippage: number,
    rec: TradeRecord
  ): Promise<void> {
    const { tokenAddress, stableAddress, routerAddress } = this.settings;
    const signer   = getChainSigner(chain);
    const router   = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
    const provider = signer.provider!;

    const erc20Dec  = ['function decimals() view returns (uint8)'];
    const erc20Full = [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ];

    const [tokenDec, stableDec] = await Promise.all([
      Number(await new ethers.Contract(tokenAddress,  erc20Dec, provider).decimals()),
      Number(await new ethers.Contract(stableAddress, erc20Dec, provider).decimals()),
    ]);

    let tx: { hash: string; wait: () => Promise<unknown> };

    if (action === 'SELL') {
      const amtIn  = ethers.parseUnits(amount.toFixed(tokenDec), tokenDec);
      const [, out] = await router.getAmountsOut(amtIn, [tokenAddress, stableAddress]);
      const minOut  = (out * BigInt(Math.floor((1 - slippage) * 10000))) / 10000n;
      const tok = new ethers.Contract(tokenAddress, erc20Full, signer);
      if ((await tok.allowance(signer.address, routerAddress)) < amtIn) {
        const t = await tok.approve(routerAddress, ethers.MaxUint256, await txOverrides(chain)); await t.wait();
      }
      tx = await router.swapExactTokensForTokens(
        amtIn, minOut, [tokenAddress, stableAddress],
        signer.address, Math.floor(Date.now() / 1000) + 300,
        { gasPrice: await getGasPrice(chain) }
      );
      rec.tokenAmount  = amount;
      rec.stableAmount = parseFloat(ethers.formatUnits(out, stableDec));
    } else {
      const amtIn  = ethers.parseUnits(amount.toFixed(stableDec), stableDec);
      const [, out] = await router.getAmountsOut(amtIn, [stableAddress, tokenAddress]);
      const minOut  = (out * BigInt(Math.floor((1 - slippage) * 10000))) / 10000n;
      const stb = new ethers.Contract(stableAddress, erc20Full, signer);
      if ((await stb.allowance(signer.address, routerAddress)) < amtIn) {
        const t = await stb.approve(routerAddress, ethers.MaxUint256, await txOverrides(chain)); await t.wait();
      }
      tx = await router.swapExactTokensForTokens(
        amtIn, minOut, [stableAddress, tokenAddress],
        signer.address, Math.floor(Date.now() / 1000) + 300,
        { gasPrice: await getGasPrice(chain) }
      );
      rec.stableAmount = amount;
      rec.tokenAmount  = parseFloat(ethers.formatUnits(out, tokenDec));
    }

    rec.txHash = tx.hash;
    logger.info('EVM trade submitted', { chain, action, txHash: tx.hash });
    await tx.wait();

    const after = await priceMonitor.getPrice(chain);
    rec.priceAfter = after.price;
    rec.status = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('EVM trade confirmed', { chain, action, txHash: tx.hash });
  }

  // ── Solana trade (via Jupiter — works with any token) ─────────────────────

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
    rec.status = 'SUCCESS';
    this.lastTradeAt = new Date();
    if (action === 'BUY') this.dailySpendUsd += amount;
    logger.info('Solana trade confirmed', { action, sig: txSignature.slice(0, 16) });
  }

  // ── Pool management ───────────────────────────────────────────────────────

  async findPair(): Promise<string | null> {
    const { chain, tokenAddress, stableAddress, routerAddress } = this.settings;

    if (chain === 'solana') {
      if (!tokenAddress || !stableAddress) return null;
      const { findSolanaPool } = await import('../solana/raydiumPool');
      return findSolanaPool(tokenAddress, stableAddress);
    }

    if (!tokenAddress || !stableAddress || !routerAddress) return null;
    const signer = getChainSigner(chain);
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);
    const factoryAddr: string = await router.factory();
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, signer);
    const pair: string = await factory.getPair(tokenAddress, stableAddress);
    return pair === ethers.ZeroAddress ? null : pair;
  }

  async initializePool(tokenAmount: number, stableAmount: number): Promise<{
    isNewPair: boolean;
    pairAddress: string;
    createTxHash: string | null;
    liquidityTxHash: string;
  }> {
    const { chain, tokenAddress, stableAddress, routerAddress } = this.settings;

    // ── Solana: Raydium CPMM ──────────────────────────────────────────────────
    if (chain === 'solana') {
      if (!tokenAddress || !stableAddress)
        throw new Error('Token mint and stable mint must be set first');
      const { initializeSolanaPool } = await import('../solana/raydiumPool');
      const res = await initializeSolanaPool(tokenAddress, stableAddress, tokenAmount, stableAmount);
      this.settings.pairAddress = res.poolId;
      this.emit('stateChange', this.state);
      return {
        isNewPair: res.isNewPool,
        pairAddress: res.poolId,
        createTxHash: res.txHash,
        liquidityTxHash: res.txHash ?? '',
      };
    }

    // ── EVM: PancakeSwap V2 / Uniswap V2 ─────────────────────────────────────
    if (!tokenAddress || !stableAddress || !routerAddress)
      throw new Error('Token address, stable address, and router address must all be set first');

    const signer = getChainSigner(chain);
    const router = new ethers.Contract(routerAddress, ROUTER_ABI, signer);

    const factoryAddr: string = await router.factory();
    const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, signer);

    let pairAddress: string = await factory.getPair(tokenAddress, stableAddress);
    let isNewPair = false;
    let createTxHash: string | null = null;

    if (pairAddress === ethers.ZeroAddress) {
      logger.info('Pair does not exist — creating', { chain, tokenAddress, stableAddress });
      const createTx = await factory.createPair(tokenAddress, stableAddress, {
        gasPrice: await getGasPrice(chain),
      });
      await createTx.wait();
      createTxHash = createTx.hash;
      pairAddress = await factory.getPair(tokenAddress, stableAddress);
      if (pairAddress === ethers.ZeroAddress)
        throw new Error('createPair succeeded but pair address still zero — check token addresses');
      isNewPair = true;
      logger.info('Pair created', { pairAddress, createTxHash });
    }

    const erc20Abi = [
      'function decimals() view returns (uint8)',
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
    ];
    const provider = signer.provider!;
    const [tokenDec, stableDec] = await Promise.all([
      Number(await new ethers.Contract(tokenAddress,  erc20Abi, provider).decimals()),
      Number(await new ethers.Contract(stableAddress, erc20Abi, provider).decimals()),
    ]);

    const tokenRaw  = ethers.parseUnits(tokenAmount.toFixed(tokenDec),   tokenDec);
    const stableRaw = ethers.parseUnits(stableAmount.toFixed(stableDec), stableDec);

    const tokenContract  = new ethers.Contract(tokenAddress,  erc20Abi, signer);
    const stableContract = new ethers.Contract(stableAddress, erc20Abi, signer);

    const [tokAllow, stbAllow] = await Promise.all([
      tokenContract.allowance(signer.address, routerAddress),
      stableContract.allowance(signer.address, routerAddress),
    ]);
    if (BigInt(tokAllow) < tokenRaw) {
      const t = await tokenContract.approve(routerAddress, ethers.MaxUint256); await t.wait();
    }
    if (BigInt(stbAllow) < stableRaw) {
      const t = await stableContract.approve(routerAddress, ethers.MaxUint256); await t.wait();
    }

    // 5% slippage floor for initial liquidity — first LP so no price impact risk
    const minToken  = (tokenRaw  * 95n) / 100n;
    const minStable = (stableRaw * 95n) / 100n;
    const deadline  = Math.floor(Date.now() / 1000) + 600;

    const liquidityTx = await router.addLiquidity(
      tokenAddress, stableAddress,
      tokenRaw, stableRaw,
      minToken, minStable,
      signer.address, deadline,
      { gasPrice: await getGasPrice(chain) }
    );
    await liquidityTx.wait();

    this.settings.pairAddress = pairAddress;
    this.emit('stateChange', this.state);
    logger.info('Pool initialized', { pairAddress, chain, tokenAmount, stableAmount, isNewPair });

    return { isNewPair, pairAddress, createTxHash, liquidityTxHash: liquidityTx.hash };
  }

  private async _saveRecord(rec: TradeRecord): Promise<void> {
    try {
      await query(
        `INSERT INTO peg_trades (timestamp,action,chain,token_amount,stable_amount,price_before,price_after,tx_hash,status,error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [rec.timestamp, rec.action, rec.chain, rec.tokenAmount, rec.stableAmount,
         rec.priceBefore, rec.priceAfter, rec.txHash, rec.status, rec.error ?? null]
      );
    } catch { /* non-fatal */ }
  }

  async getTradeHistory(limit = 50, offset = 0): Promise<TradeRecord[]> {
    return query<TradeRecord>(
      `SELECT * FROM peg_trades ORDER BY timestamp DESC LIMIT $1 OFFSET $2`, [limit, offset]
    );
  }

  async getDailyStats() {
    const rows = await query<{ total_trades: string; total_buy_usd: string; total_sell_tokens: string }>(
      `SELECT COUNT(*) total_trades,
              COALESCE(SUM(CASE WHEN action='BUY'  THEN stable_amount END),0) total_buy_usd,
              COALESCE(SUM(CASE WHEN action='SELL' THEN token_amount  END),0) total_sell_tokens
       FROM peg_trades WHERE timestamp > NOW()-INTERVAL '24 hours' AND status='SUCCESS'`
    );
    const r = rows[0];
    return {
      totalTrades:     parseInt(r?.total_trades ?? '0'),
      totalBuyUsd:     parseFloat(r?.total_buy_usd ?? '0'),
      totalSellTokens: parseFloat(r?.total_sell_tokens ?? '0'),
    };
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __pegMaintainer: PegMaintainer | undefined }
export const pegMaintainer: PegMaintainer = global.__pegMaintainer ?? new PegMaintainer();
global.__pegMaintainer = pegMaintainer;
