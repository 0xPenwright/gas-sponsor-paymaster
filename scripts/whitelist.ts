import { ethers } from "hardhat";

/**
 * Whitelist one or more senders on a deployed SponsorPaymaster.
 *
 *   PAYMASTER_ADDRESS=0x... SENDERS=0xabc,0xdef DAILY_LIMIT=5000000000000000 \
 *     npx hardhat run scripts/whitelist.ts --network baseSepolia
 */
async function main() {
  const paymasterAddress = process.env.PAYMASTER_ADDRESS;
  const sendersCsv = process.env.SENDERS;
  const dailyLimit = process.env.DAILY_LIMIT ?? "0"; // 0 → contract default

  if (!paymasterAddress) throw new Error("PAYMASTER_ADDRESS env var is required");
  if (!sendersCsv) throw new Error("SENDERS env var is required (comma-separated addresses)");

  const senders = sendersCsv.split(",").map((s) => s.trim());
  const pm = await ethers.getContractAt("SponsorPaymaster", paymasterAddress);

  console.log(`Whitelisting ${senders.length} sender(s) with daily limit ${dailyLimit} wei`);
  const tx = senders.length === 1
    ? await pm.whitelist(senders[0], dailyLimit)
    : await pm.whitelistBatch(senders, dailyLimit);

  const receipt = await tx.wait();
  console.log(`Done in tx ${receipt!.hash} (block ${receipt!.blockNumber})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
