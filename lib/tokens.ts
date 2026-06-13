// Official token addresses and DEX router/factory addresses for each supported chain.
// Single source of truth — imported by peg UI, wallet panel, and balance API.

export type ChainId = 'bsc' | 'ethereum' | 'solana';

// V3 fee tiers (in hundredths of a basis point)
export const V3_FEE_TIERS = [100, 500, 2500, 3000, 10000] as const;
export type V3FeeTier = (typeof V3_FEE_TIERS)[number];

export const CHAIN_TOKENS = {
  bsc: {
    native:  { symbol: 'BNB',  decimals: 18 },
    // BSC USDC (Binance-pegged, 18 decimals)
    usdc:    { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
    // BSC USDT (Tether, 18 decimals)
    usdt:    { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    // Wrapped BNB
    wNative: { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
    router:  '0x1b81D678ffb9C0263b24A97847620C99d213eB14', // PancakeSwap V3 SmartRouter
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865', // PancakeSwap V3 Factory
    dex:     'PancakeSwap V3',
    defaultFeeTier: 2500 as V3FeeTier, // 0.25%
  },
  ethereum: {
    native:  { symbol: 'ETH',  decimals: 18 },
    // Ethereum USDC (Circle, 6 decimals)
    usdc:    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    // Ethereum USDT (Tether, 6 decimals)
    usdt:    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    // Wrapped ETH
    wNative: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    router:  '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 SwapRouter
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3 Factory
    dex:     'Uniswap V3',
    defaultFeeTier: 3000 as V3FeeTier, // 0.3%
  },
  solana: {
    native:  { symbol: 'SOL',  decimals: 9 },
    // Solana USDC (Circle)
    usdc:    { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    // Solana USDT (Tether)
    usdt:    { symbol: 'USDT', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
    // Wrapped SOL
    wNative: { symbol: 'wSOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
    router:  '', // Raydium CPMM has no single router; routed via Jupiter
    factory: '',
    dex:     'Raydium CPMM',
    defaultFeeTier: 0 as V3FeeTier,
  },
} as const;

export type ChainTokens = (typeof CHAIN_TOKENS)[ChainId];
