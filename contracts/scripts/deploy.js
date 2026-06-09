const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying MultiSender with account:', deployer.address);
  console.log('Balance:', ethers.formatEther(await deployer.provider.getBalance(deployer.address)), 'BNB');

  const MultiSender = await ethers.getContractFactory('MultiSender');
  const multiSender = await MultiSender.deploy();
  await multiSender.waitForDeployment();

  const address = await multiSender.getAddress();
  console.log('MultiSender deployed to:', address);
  console.log('');
  console.log('Add to .env:');
  console.log(`MULTISENDER_ADDRESS=${address}`);
  console.log('');
  console.log('To verify on BSCScan:');
  console.log(`npx hardhat verify --network bscTestnet ${address}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
