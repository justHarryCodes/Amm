function opt(key: string, fallback: string) {
  return process.env[key] ?? fallback;
}

// Return first non-empty value
const first = (...vals: string[]) => vals.find(v => v.length > 0) ?? '';

export const config = {
  apiSecret: opt('API_SECRET', 'dev-secret'),
  network: opt('NETWORK', 'testnet') as 'mainnet' | 'testnet',

  rpc: {
    mainnet: opt('BSC_RPC_URL',         'https://bsc-dataseed.binance.org/'),
    testnet: opt('BSC_TESTNET_RPC_URL', 'https://data-seed-prebsc-1-s1.binance.org:8545/'),
  },

  // EVM wallet: BOT_PRIVATE_KEY works on BOTH BSC and Ethereum (same secp256k1 address)
  wallet: { privateKey: opt('BOT_PRIVATE_KEY', '') },

  // Legacy BSC bulk sender addresses (kept for BNB bulk sender)
  tokens: {
    token: opt('TOKEN_ADDRESS', ''),
    usdc:  opt('USDC_ADDRESS',  ''),
    usdt:  opt('USDT_ADDRESS',  ''),
    pair:  opt('PAIR_ADDRESS',  ''),
  },

  pancake: {
    router:  opt('PANCAKE_ROUTER',  '0x10ED43C718714eb63d5aA57B78B54704E256024E'),
    factory: opt('PANCAKE_FACTORY', '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'),
  },

  multiSender: {
    address: opt('MULTISENDER_ADDRESS', '0xfc13372d4747Bbf846a8ADd351aF32E0Be956836'),
  },

  peg: {
    chain: opt('PEG_CHAIN', 'bsc') as 'bsc' | 'ethereum' | 'solana',
    targetPeg:           parseFloat(opt('TARGET_PEG',            '1.0')),
    upperBand:           parseFloat(opt('UPPER_BAND',            '0.02')),
    lowerBand:           parseFloat(opt('LOWER_BAND',            '0.02')),
    maxTradeSizeTokens:  parseFloat(opt('MAX_TRADE_SIZE_TOKENS', '1000')),
    maxDailySpendUsd:    parseFloat(opt('MAX_DAILY_SPEND_USD',   '500')),
    minLiquidityUsd:     parseFloat(opt('MIN_LIQUIDITY_USD',     '2')),
    cooldownSeconds:     parseInt(  opt('COOLDOWN_SECONDS',      '300')),
    slippageTolerance:   parseFloat(opt('SLIPPAGE_TOLERANCE',    '0.005')),
  },

  // Per-chain token/pool config for peg maintainer
  pegChains: {
    bsc: {
      rpcMainnet:    opt('BSC_RPC_URL',         'https://bsc-dataseed.binance.org/'),
      rpcTestnet:    opt('BSC_TESTNET_RPC_URL', 'https://data-seed-prebsc-1-s1.binance.org:8545/'),
      routerAddress: opt('PANCAKE_ROUTER',  '0x10ED43C718714eb63d5aA57B78B54704E256024E'),
      tokenAddress:  first(opt('BSC_PEG_TOKEN', ''),  opt('TOKEN_ADDRESS', '')),
      stableAddress: first(opt('BSC_PEG_STABLE', ''), opt('USDC_ADDRESS', ''), opt('USDT_ADDRESS', '')),
      pairAddress:   first(opt('BSC_PEG_PAIR', ''),   opt('PAIR_ADDRESS', '')),
    },
    ethereum: {
      rpcUrl:        opt('ETH_RPC_URL',        'https://eth.llamarpc.com'),
      routerAddress: opt('ETH_ROUTER_ADDRESS', '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'), // Uniswap V2
      tokenAddress:  opt('ETH_TOKEN_ADDRESS',  ''),
      stableAddress: opt('ETH_STABLE_ADDRESS', ''),
      pairAddress:   opt('ETH_PAIR_ADDRESS',   ''),
    },
    solana: {
      tokenMint:       opt('SOLANA_PEG_TOKEN_MINT',  ''),
      stableMint:      opt('SOLANA_PEG_STABLE_MINT', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
      jupiterQuoteApi: opt('JUPITER_QUOTE_API', 'https://lite-api.jup.ag/swap/v1'),
      jupiterPriceApi: opt('JUPITER_PRICE_API', ''), // deprecated — price now derived from quote
    },
  },

  alchemy: {
    apiKey: opt('ALCHEMY_API_KEY', ''),
  },

  database: { url: opt('DATABASE_URL', '') },

  solana: {
    network:        opt('SOLANA_NETWORK',      'mainnet-beta') as 'mainnet-beta' | 'devnet' | 'testnet',
    rpcUrl:         opt('SOLANA_RPC_URL',      'https://api.mainnet-beta.solana.com'),
    privateKey:     opt('SOLANA_PRIVATE_KEY',  ''), // base58-encoded 64-byte secret key
    batchSize:      parseInt(opt('SOLANA_BATCH_SIZE',      '10')),
    concurrency:    parseInt(opt('SOLANA_CONCURRENCY',     '3')),
    priorityFee:    parseInt(opt('SOLANA_PRIORITY_FEE',    '1000')),
    maxRetries:     parseInt(opt('SOLANA_MAX_RETRIES',     '3')),
    confirmTimeout: parseInt(opt('SOLANA_CONFIRM_TIMEOUT', '60')),
  },
};

export type PegChain = 'bsc' | 'ethereum' | 'solana';
