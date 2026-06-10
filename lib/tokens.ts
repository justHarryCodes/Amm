// Official token addresses and DEX router addresses for each supported chain.
// Single source of truth — imported by peg UI, wallet panel, and balance API.

export type ChainId = 'bsc' | 'ethereum' | 'solana';

export const CHAIN_TOKENS = {
  bsc: {
    native:  { symbol: 'BNB',  decimals: 18 },
    // BSC USDC (Binance-pegged, 18 decimals)
    usdc:    { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    // BSC USDT (Tether, 18 decimals)
    usdt:    { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    // Wrapped BNB — used as the native-asset leg in liquidity pairs
    wNative: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    router:  '0x10ED43C718714eb63d5aA57B78B54704E256024E', // PancakeSwap V2 Router
    factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73', // PancakeSwap V2 Factory
    dex:     'PancakeSwap V2',
  },
  ethereum: {
    native:  { symbol: 'ETH',  decimals: 18 },
    // Ethereum USDC (Circle, 6 decimals)
    usdc:    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    // Ethereum USDT (Tether, 6 decimals)
    usdt:    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    // Wrapped ETH — used as the native-asset leg in liquidity pairs
    wNative: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    router:  '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', // Uniswap V2 Router
    factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f', // Uniswap V2 Factory
    dex:     'Uniswap V2',
  },
  solana: {
    native:  { symbol: 'SOL',  decimals: 9 },
    // Solana USDC (Circle)
    usdc:    { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    // Solana USDT (Tether)
    usdt:    { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    // Wrapped SOL — used as the native-asset leg in Raydium pools
    wNative: { symbol: 'wSOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
    router:  '', // Raydium CPMM has no single router address; routed via Jupiter
    dex:     'Raydium CPMM',
  },
} as const;

export type ChainTokens = (typeof CHAIN_TOKENS)[ChainId];
