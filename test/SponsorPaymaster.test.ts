import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { SponsorPaymaster, MockEntryPoint } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const DAY = 24 * 60 * 60;
const DEFAULT_DAILY_LIMIT = ethers.parseEther("0.005");

function emptyUserOp(sender: string) {
  return {
    sender,
    nonce: 0n,
    initCode: "0x" as const,
    callData: "0x" as const,
    accountGasLimits: ethers.zeroPadValue("0x", 32),
    preVerificationGas: 21000n,
    gasFees: ethers.zeroPadValue("0x", 32),
    paymasterAndData: "0x" as const,
    signature: "0x" as const,
  };
}

const PostOpMode = { opSucceeded: 0, opReverted: 1 };

describe("SponsorPaymaster", () => {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let entryPoint: MockEntryPoint;
  let paymaster: SponsorPaymaster;

  beforeEach(async () => {
    [owner, stranger, alice, bob] = await ethers.getSigners();

    const EP = await ethers.getContractFactory("MockEntryPoint");
    entryPoint = await EP.deploy();

    const PM = await ethers.getContractFactory("SponsorPaymaster");
    paymaster = await PM.deploy(await entryPoint.getAddress(), owner.address);
  });

  // ─── Constructor & access control ──────────────────────────────────────

  describe("constructor", () => {
    it("sets the EntryPoint", async () => {
      expect(await paymaster.entryPoint()).to.equal(await entryPoint.getAddress());
    });

    it("sets the owner to the given address", async () => {
      expect(await paymaster.owner()).to.equal(owner.address);
    });

    it("supports owner != deployer", async () => {
      const PM = await ethers.getContractFactory("SponsorPaymaster");
      const pm = await PM.connect(stranger).deploy(await entryPoint.getAddress(), alice.address);
      expect(await pm.owner()).to.equal(alice.address);
    });
  });

  describe("access control", () => {
    it("rejects whitelist from non-owner", async () => {
      await expect(paymaster.connect(stranger).whitelist(alice.address, 0))
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });

    it("rejects pause from non-owner", async () => {
      await expect(paymaster.connect(stranger).pause())
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });

    it("rejects remove from non-owner", async () => {
      await expect(paymaster.connect(stranger).remove(alice.address))
        .to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });
  });

  // ─── Whitelist ─────────────────────────────────────────────────────────

  describe("whitelist", () => {
    it("applies the default daily limit when caller passes 0", async () => {
      await expect(paymaster.whitelist(alice.address, 0))
        .to.emit(paymaster, "SenderWhitelisted")
        .withArgs(alice.address, DEFAULT_DAILY_LIMIT);

      const allowance = await paymaster.allowances(alice.address);
      expect(allowance.dailyLimit).to.equal(DEFAULT_DAILY_LIMIT);
      expect(allowance.spentToday).to.equal(0);
    });

    it("respects a custom daily limit", async () => {
      const limit = ethers.parseEther("0.01");
      await paymaster.whitelist(alice.address, limit);
      const allowance = await paymaster.allowances(alice.address);
      expect(allowance.dailyLimit).to.equal(limit);
    });

    it("re-whitelisting resets spentToday to 0", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.01"));
      // simulate post-op accounting via reset → re-whitelist
      await paymaster.whitelist(alice.address, ethers.parseEther("0.02"));
      const allowance = await paymaster.allowances(alice.address);
      expect(allowance.spentToday).to.equal(0);
      expect(allowance.dailyLimit).to.equal(ethers.parseEther("0.02"));
    });
  });

  describe("whitelistBatch", () => {
    it("whitelists multiple senders with the same limit", async () => {
      const limit = ethers.parseEther("0.003");
      await paymaster.whitelistBatch([alice.address, bob.address], limit);

      expect((await paymaster.allowances(alice.address)).dailyLimit).to.equal(limit);
      expect((await paymaster.allowances(bob.address)).dailyLimit).to.equal(limit);
    });

    it("emits SenderWhitelisted for every entry", async () => {
      const tx = await paymaster.whitelistBatch([alice.address, bob.address], 0);
      const receipt = await tx.wait();
      const events = receipt!.logs.filter((l) => "fragment" in l && (l as any).fragment?.name === "SenderWhitelisted");
      expect(events.length).to.equal(2);
    });

    it("works for an empty array", async () => {
      await expect(paymaster.whitelistBatch([], 0)).to.not.be.reverted;
    });
  });

  describe("remove", () => {
    it("removes the sender and emits", async () => {
      await paymaster.whitelist(alice.address, 0);
      await expect(paymaster.remove(alice.address))
        .to.emit(paymaster, "SenderRemoved")
        .withArgs(alice.address);
      expect((await paymaster.allowances(alice.address)).dailyLimit).to.equal(0);
    });
  });

  // ─── Views ─────────────────────────────────────────────────────────────

  describe("remainingToday", () => {
    it("returns 0 for non-whitelisted sender", async () => {
      expect(await paymaster.remainingToday(alice.address)).to.equal(0);
    });

    it("returns full limit for fresh whitelist", async () => {
      await paymaster.whitelist(alice.address, 0);
      expect(await paymaster.remainingToday(alice.address)).to.equal(DEFAULT_DAILY_LIMIT);
    });

    it("returns full limit on a new day even if spent earlier", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.01"));
      const userOp = emptyUserOp(alice.address);
      const [context] = await entryPoint.callValidate.staticCall(
        await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.001"),
      );
      await entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.001"));
      await entryPoint.callPostOp(await paymaster.getAddress(), PostOpMode.opSucceeded, context, ethers.parseEther("0.001"), 0);

      // Move past the next UTC day boundary
      await time.increase(DAY + 1);
      expect(await paymaster.remainingToday(alice.address)).to.equal(ethers.parseEther("0.01"));
    });
  });

  // ─── Pause ─────────────────────────────────────────────────────────────

  describe("pause / unpause", () => {
    it("blocks validation while paused", async () => {
      await paymaster.whitelist(alice.address, 0);
      await paymaster.pause();
      const userOp = emptyUserOp(alice.address);
      await expect(
        entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, 100),
      ).to.be.revertedWithCustomError(paymaster, "EnforcedPause");
    });

    it("unpause restores validation", async () => {
      await paymaster.whitelist(alice.address, 0);
      await paymaster.pause();
      await paymaster.unpause();
      const userOp = emptyUserOp(alice.address);
      await expect(
        entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, 100),
      ).to.not.be.reverted;
    });
  });

  // ─── Validation ────────────────────────────────────────────────────────

  describe("validatePaymasterUserOp", () => {
    it("reverts when called by a non-EntryPoint caller", async () => {
      const userOp = emptyUserOp(alice.address);
      await expect(
        paymaster.connect(stranger).validatePaymasterUserOp(userOp, ethers.ZeroHash, 100),
      ).to.be.revertedWith("Sender not EntryPoint");
    });

    it("rejects non-whitelisted sender", async () => {
      const userOp = emptyUserOp(alice.address);
      await expect(
        entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, 100),
      ).to.be.revertedWithCustomError(paymaster, "SenderNotWhitelisted")
       .withArgs(alice.address);
    });

    it("rejects when maxCost exceeds daily limit", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.001"));
      const userOp = emptyUserOp(alice.address);
      await expect(
        entryPoint.callValidate(
          await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.002"),
        ),
      )
        .to.be.revertedWithCustomError(paymaster, "DailyLimitExceeded")
        .withArgs(alice.address, ethers.parseEther("0.002"), ethers.parseEther("0.001"));
    });

    it("accepts when within limit", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.01"));
      const userOp = emptyUserOp(alice.address);
      await expect(
        entryPoint.callValidate(
          await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.001"),
        ),
      ).to.not.be.reverted;
    });
  });

  // ─── postOp accounting ─────────────────────────────────────────────────

  describe("_postOp", () => {
    it("decreases remainingToday by actualGasCost", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.01"));
      const userOp = emptyUserOp(alice.address);
      const actualCost = ethers.parseEther("0.0012");

      await entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, actualCost);
      const context = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint32"],
        [alice.address, Math.floor((await time.latest()) / DAY)],
      );

      await expect(
        entryPoint.callPostOp(await paymaster.getAddress(), PostOpMode.opSucceeded, context, actualCost, 0),
      ).to.emit(paymaster, "GasSponsored");

      expect(await paymaster.remainingToday(alice.address))
        .to.equal(ethers.parseEther("0.01") - actualCost);
    });

    it("rejects postOp from non-EntryPoint", async () => {
      const context = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint32"], [alice.address, 0],
      );
      await expect(
        paymaster.connect(stranger).postOp(0, context, 100, 0),
      ).to.be.revertedWith("Sender not EntryPoint");
    });

    it("resets spentToday at day boundary inside postOp", async () => {
      await paymaster.whitelist(alice.address, ethers.parseEther("0.01"));
      const userOp = emptyUserOp(alice.address);

      // Day 1 spend
      await entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.001"));
      const ctx1 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint32"], [alice.address, Math.floor((await time.latest()) / DAY)],
      );
      await entryPoint.callPostOp(await paymaster.getAddress(), 0, ctx1, ethers.parseEther("0.001"), 0);

      // Roll to next day, validate again
      await time.increase(DAY + 1);
      await entryPoint.callValidate(await paymaster.getAddress(), userOp, ethers.ZeroHash, ethers.parseEther("0.005"));
      const ctx2 = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "uint32"], [alice.address, Math.floor((await time.latest()) / DAY)],
      );
      await entryPoint.callPostOp(await paymaster.getAddress(), 0, ctx2, ethers.parseEther("0.005"), 0);

      // spentToday should be only the day-2 spend
      const allowance = await paymaster.allowances(alice.address);
      expect(allowance.spentToday).to.equal(ethers.parseEther("0.005"));
    });
  });

  // ─── Deposits ──────────────────────────────────────────────────────────

  describe("deposits", () => {
    it("deposit forwards value to the EntryPoint", async () => {
      const before = await entryPoint.balanceOf(await paymaster.getAddress());
      await paymaster.deposit({ value: ethers.parseEther("0.5") });
      const after = await entryPoint.balanceOf(await paymaster.getAddress());
      expect(after - before).to.equal(ethers.parseEther("0.5"));
    });

    it("only owner can withdraw", async () => {
      await paymaster.deposit({ value: ethers.parseEther("0.5") });
      await expect(
        paymaster.connect(stranger).withdrawTo(stranger.address, ethers.parseEther("0.1")),
      ).to.be.revertedWithCustomError(paymaster, "OwnableUnauthorizedAccount");
    });

    it("owner can withdraw to any address", async () => {
      await paymaster.deposit({ value: ethers.parseEther("0.5") });
      const before = await ethers.provider.getBalance(bob.address);
      await paymaster.withdrawTo(bob.address, ethers.parseEther("0.3"));
      const after = await ethers.provider.getBalance(bob.address);
      expect(after - before).to.equal(ethers.parseEther("0.3"));
    });
  });

  // ─── Fuzz-ish: many small ops within a limit ───────────────────────────

  describe("usage patterns", () => {
    it("a sender can submit up to N ops while total stays under limit", async () => {
      const limit = ethers.parseEther("0.01");
      const each = ethers.parseEther("0.001");
      await paymaster.whitelist(alice.address, limit);
      const userOp = emptyUserOp(alice.address);
      const pmAddr = await paymaster.getAddress();

      const day = Math.floor((await time.latest()) / DAY);
      const ctx = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint32"], [alice.address, day]);

      for (let i = 0; i < 10; i++) {
        await entryPoint.callValidate(pmAddr, userOp, ethers.ZeroHash, each);
        await entryPoint.callPostOp(pmAddr, 0, ctx, each, 0);
      }
      expect((await paymaster.allowances(alice.address)).spentToday).to.equal(limit);

      // 11th must fail
      await expect(entryPoint.callValidate(pmAddr, userOp, ethers.ZeroHash, each))
        .to.be.revertedWithCustomError(paymaster, "DailyLimitExceeded");
    });
  });
});
