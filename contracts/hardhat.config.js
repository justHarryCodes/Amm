require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const alchemyKey = process.env.ALCHEMY_API_KEY ?? '';

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    bscTestnet: {
      url: `https://bnb-testnet.g.alchemy.com/v2/${alchemyKey}`,
      chainId: 97,
      accounts: process.env.BOT_PRIVATE_KEY ? [process.env.BOT_PRIVATE_KEY] : [],
    },
    bscMainnet: {
      url: `https://bnb-mainnet.g.alchemy.com/v2/${alchemyKey}`,
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
