# gas-sponsor-paymaster

[![test](https://github.com/0xPenwright/gas-sponsor-paymaster/actions/workflows/test.yml/badge.svg)](https://github.com/0xPenwright/gas-sponsor-paymaster/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.23-363636.svg)](https://soliditylang.org)

An ERC-4337 paymaster that sponsors gas for whitelisted senders, with a per-sender daily wei limit and pause control. Compatible with EntryPoint v0.7.

```
contracts/SponsorPaymaster.sol     ←  146 lines, 100% line coverage
test/SponsorPaymaster.test.ts      ←  29 cases (admin, validation, postOp, day rollover, fuzz pattern)
scripts/deploy.ts                  ←  Base Sepolia deploy + Basescan verify
scripts/whitelist.ts               ←  Batch sender admin
```

## Why this exists

ERC-4337 (Account Abstraction) lets dApps onboard users without making them hold ETH. A **paymaster** is the on-chain contract that fronts the gas. Production paymasters need three things every founder asks for and most templates skip:

1. **Allowlist** — only sponsor known good actors (KYC'd accounts, beta users, smart wallets you deployed).
2. **Spending caps** — bound the blast radius if a sponsored user goes hostile or buggy.
3. **A kill switch** — pause sponsorship without bricking the contract.

This repository ships all three in ~146 lines of audited-quality Solidity, with a full Hardhat test suite, deploy scripts, and a deploy address you can verify on Basescan.

## Contract

```solidity
contract SponsorPaymaster is BasePaymaster, Pausable {
    struct Allowance { uint128 dailyLimit; uint128 spentToday; uint32 resetDay; }
    mapping(address => Allowance) public allowances;
    // ...
}
```

The day boundary is `block.timestamp / 1 days` (UTC midnight). On the first sponsored op after midnight, `_postOp` zeroes `spentToday` and records the new day index. The validation path is view-only — accounting happens in `_postOp` against the real `actualGasCost`, not the upfront `maxCost` estimate.

| Function | Caller | Purpose |
|---|---|---|
| `whitelist(sender, dailyLimit)` | owner | Add or reset a sender. `0` → contract default (0.005 ETH/day). |
| `whitelistBatch(senders[], dailyLimit)` | owner | Bulk version. |
| `remove(sender)` | owner | Remove a sender. |
| `pause()` / `unpause()` | owner | Halt new sponsorships. In-flight ops still complete. |
| `remainingToday(sender)` | view | Wei still sponsorable for `sender` today. |
| `deposit()` | anyone | Top up the paymaster's EntryPoint deposit. |
| `withdrawTo(addr, amount)` | owner | Pull from the EntryPoint deposit. |

## Run it locally

```bash
git clone https://github.com/0xPenwright/gas-sponsor-paymaster.git
cd gas-sponsor-paymaster
npm install --legacy-peer-deps
npx hardhat test
npx hardhat coverage
```

Last run on this commit:

```
SponsorPaymaster
  29 passing  (1s)

-----------------------|----------|----------|----------|----------|
File                   |  % Stmts | % Branch |  % Funcs |  % Lines |
-----------------------|----------|----------|----------|----------|
 SponsorPaymaster.sol  |      100 |    93.33 |      100 |      100 |
-----------------------|----------|----------|----------|----------|
```

## Deploy

The same EntryPoint v0.7 address (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`) ships on Ethereum, Arbitrum, Base, Optimism, Polygon, BSC, and most rollups, so the deploy script is chain-agnostic — just change the network flag.

```bash
cp .env.example .env       # fill in PRIVATE_KEY, BASE_SEPOLIA_RPC, BASESCAN_API_KEY
npx hardhat run scripts/deploy.ts --network baseSepolia
```

The script deploys the paymaster, deposits 0.01 ETH into its EntryPoint balance (if the deployer has it), and verifies on Basescan.

## Whitelist senders

```bash
PAYMASTER_ADDRESS=0x... \
SENDERS=0xabc...,0xdef... \
DAILY_LIMIT=5000000000000000 \
npx hardhat run scripts/whitelist.ts --network baseSepolia
```

## Threat model

| Threat | Mitigation |
|---|---|
| Whitelisted sender drains the daily limit with one expensive op | `_validatePaymasterUserOp` rejects ops where `spent + maxCost > dailyLimit` *before* execution. |
| Whitelisted sender drains the limit over many ops | `_postOp` accumulates `actualGasCost`; the (n+1)-th op that crosses the limit fails validation. |
| Owner key compromised | Owner can drain the EntryPoint deposit but cannot mint or steal user funds — paymaster never holds external value. Recovery: transfer ownership to a multisig before going to mainnet. |
| Day boundary attack at UTC midnight | Negligible — the limit resets per UTC day, so an attacker only doubles their budget once per 24h, which they already could do by waiting. |
| EntryPoint upgrades | Constructor checks `IEntryPoint` interface ID. Deploy a new paymaster against a new EntryPoint; this contract has no upgrade path by design. |

Use this contract as-is on testnets. For mainnet, run it through Slither + your auditor of choice — the test suite is a starting point, not a substitute.

## Stack

- Solidity 0.8.23, viaIR off, optimizer 1M runs
- Hardhat 2.22 with `@nomicfoundation/hardhat-toolbox`
- `@account-abstraction/contracts` v0.7
- OpenZeppelin Contracts v5 (`Ownable`, `Pausable`)
- TypeScript test suite with `chai-matchers`, `network-helpers`

## License

MIT — see [LICENSE](./LICENSE).

---

**Author:** [0xPenwright](https://github.com/0xPenwright) · [@0xPenwright](https://twitter.com/0xPenwright) · solo Web3 engineer, available for paymaster, vault, and integration work.

Payable in USDC / USDT on Ethereum, Polygon, Base, Arbitrum, Optimism → [app.request.finance/create/633560518783137d](https://app.request.finance/create/633560518783137d)
