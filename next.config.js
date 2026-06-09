/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      'pg', 'winston', 'csv-parse',
      '@solana/web3.js', '@solana/spl-token', 'bs58',
    ],
  },
  transpilePackages: [
    'ethers',
    '@solana/wallet-adapter-base',
    '@solana/wallet-adapter-react',
    '@solana/wallet-adapter-react-ui',
    '@solana/wallet-adapter-wallets',
  ],
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      '@react-native-async-storage/async-storage': false,
      // pino-pretty is an optional pretty-printer for WalletConnect's logger — not needed
      'pino-pretty': false,
    };

    // Suppress known harmless third-party warnings:
    // 1. ox/tempo virtualMasterPool uses dynamic require (viem Tempo testnet internal, unused by us)
    // 2. pino can't find its optional pino-pretty dep at bundle time
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /node_modules\/ox\/_esm\/tempo/ },
      { module: /node_modules\/pino\/lib\/tools/ },
    ];

    return config;
  },
};

module.exports = nextConfig;
