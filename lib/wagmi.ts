import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { bsc, bscTestnet, mainnet } from 'viem/chains';
import { http } from 'wagmi';

export const wagmiConfig = getDefaultConfig({
  appName: 'PegBot',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
  chains: [bsc, bscTestnet, mainnet],
  transports: {
    [bsc.id]: http(
      process.env.NEXT_PUBLIC_BSC_RPC_URL || 'https://bsc-dataseed.binance.org/'
    ),
    [bscTestnet.id]: http('https://data-seed-prebsc-1-s1.binance.org:8545/'),
    [mainnet.id]: http(
      process.env.NEXT_PUBLIC_ETH_RPC_URL || 'https://eth.llamarpc.com'
    ),
  },
  ssr: true,
});
