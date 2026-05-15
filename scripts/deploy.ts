import { ethers, network, run } from "hardhat";

// EntryPoint v0.7 — same address on all major EVM chains.
const ENTRY_POINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  console.log(`Network:  ${network.name}`);

  const Factory = await ethers.getContractFactory("SponsorPaymaster");
  const paymaster = await Factory.deploy(ENTRY_POINT_V07, deployer.address);
  await paymaster.waitForDeployment();

  const address = await paymaster.getAddress();
  console.log(`\nSponsorPaymaster deployed at: ${address}`);

  // Top up the paymaster's EntryPoint deposit so it can sponsor immediately.
  const initialDeposit = ethers.parseEther("0.01");
  if (balance > initialDeposit + ethers.parseEther("0.002")) {
    const tx = await paymaster.deposit({ value: initialDeposit });
    await tx.wait();
    console.log(`Deposited ${ethers.formatEther(initialDeposit)} ETH to EntryPoint`);
  } else {
    console.log("\n(skipping deposit — top up the paymaster via deposit() once funded)");
  }

  if (network.name !== "hardhat" && process.env.BASESCAN_API_KEY) {
    console.log("\nVerifying on Basescan...");
    try {
      await run("verify:verify", {
        address,
        constructorArguments: [ENTRY_POINT_V07, deployer.address],
      });
      console.log("Verified.");
    } catch (e: any) {
      console.log(`Verification skipped: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
