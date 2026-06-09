require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    bscTestnet: {
      url: 'https://data-seed-prebsc-1-s1.binance.org:8545/',
      chainId: 97,
      accounts: process.env.BOT_PRIVATE_KEY ? [process.env.BOT_PRIVATE_KEY] : [],
    },
    bscMainnet: {
      url: 'https://bsc-dataseed.binance.org/',
      chainId: 56,
      accounts: process.env.BOT_PRIVATE_KEY ? [process.env.BOT_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: { bscTestnet: process.env.BSCSCAN_API_KEY ?? '', bsc: process.env.BSCSCAN_API_KEY ?? '' },
    customChains: [
      {
        network: 'bscTestnet',
        chainId: 97,
        urls: { apiURL: 'https://api-testnet.bscscan.com/api', browserURL: 'https://testnet.bscscan.com' },
      },
    ],
  },
};
