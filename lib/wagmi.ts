import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { bsc, bscTestnet, mainnet } from 'viem/chains';
import { http } from 'wagmi';

// NEXT_PUBLIC_ALCHEMY_API_KEY is exposed to the browser — restrict it to your
// domain in the Alchemy dashboard to prevent abuse.
const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? '';

export const wagmiConfig = getDefaultConfig({
  appName: 'PegBot',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
  chains: [bsc, bscTestnet, mainnet],
  transports: {
    [bsc.id]:        http(`https://bnb-mainnet.g.alchemy.com/v2/${key}`),
    [bscTestnet.id]: http(`https://bnb-testnet.g.alchemy.com/v2/${key}`),
    [mainnet.id]:    http(`https://eth-mainnet.g.alchemy.com/v2/${key}`),
  },
  ssr: true,
});
