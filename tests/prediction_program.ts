import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

import { PredictionProgramV2 } from "../target/types/prediction_program_v2";

describe("prediction_program_v2 (CPMM + fees + pro-rata) e2e", () => {
  const provider = anchor.AnchorProvider.env();
  console.log("RPC:", provider.connection.rpcEndpoint);
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PredictionProgramV2 as Program<PredictionProgramV2>;

  // Force a real Keypair payer (NodeWallet)
  const payer = (provider.wallet as any).payer as anchor.web3.Keypair;
  if (!payer) {
    throw new Error(
      "No payer found on provider.wallet. Run via `anchor test` and set ANCHOR_WALLET."
    );
  }

  const wallet = provider.wallet as anchor.Wallet;

  // -----------------------------
  // Helpers
  // -----------------------------
  function safeNumber(v: bigint | anchor.BN, label: string): number {
    const n = typeof v === "bigint" ? Number(v) : Number(v.toString());
    if (!Number.isSafeInteger(n)) {
      throw new Error(`${label} exceeds JS safe integer range: ${n}`);
    }
    return n;
  }

  function proRataPayoutFloor(
  vaultBalance: number,
  userWinningShares: number,
  totalWinningShares: number
): number {
  if (totalWinningShares <= 0) throw new Error("totalWinningShares must be > 0");
  if (userWinningShares <= 0) return 0;
  return Math.floor((vaultBalance * userWinningShares) / totalWinningShares);
}

  async function airdrop(pubkey: PublicKey, sol: number, retries = 3) {
    let lastErr: any;
    for (let i = 0; i < retries; i++) {
      try {
        const { blockhash, lastValidBlockHeight } =
          await provider.connection.getLatestBlockhash("confirmed");

        const sig = await provider.connection.requestAirdrop(
          pubkey,
          sol * LAMPORTS_PER_SOL
        );

        await provider.connection.confirmTransaction(
          { signature: sig, blockhash, lastValidBlockHeight },
          "confirmed"
        );

        return sig;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 200 * (i + 1)));
      }
    }
    throw lastErr;
  }

  async function waitForTokenAccount(addr: PublicKey, tries = 12) {
    let lastErr: any;
    for (let i = 0; i < tries; i++) {
      try {
        return await getAccount(provider.connection, addr);
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
      }
    }
    throw lastErr;
  }

  function u64LE(n: anchor.BN) {
    return n.toArrayLike(Buffer, "le", 8);
  }

  // Fee constants from on-chain program
  const FEE_BPS = 50; // 0.50%
  const BPS_DENOM = 10_000;

  function feeOnInput(grossIn: number): number {
    return Math.floor((grossIn * FEE_BPS) / BPS_DENOM);
  }
  function netInFromGross(grossIn: number): number {
    return grossIn - feeOnInput(grossIn);
  }
  function feeOnOutput(grossOut: number): number {
    return Math.floor((grossOut * FEE_BPS) / BPS_DENOM);
  }
  function netOutFromGross(grossOut: number): number {
    return grossOut - feeOnOutput(grossOut);
  }

  // -----------------------------
  // Test state
  // -----------------------------
  const initialLiquidity = new anchor.BN(1_000_000_000); // 1000.000000 (6dp)
  const marketId = new anchor.BN(Date.now());

  // Two traders
  const userA = anchor.web3.Keypair.generate();
  const userB = anchor.web3.Keypair.generate();

  // Mint + token accounts
  let collateralMint: PublicKey;
  let authorityAta: PublicKey;
  let userAAta: PublicKey;
  let userBAta: PublicKey;

  // PDAs
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let posAPda: PublicKey;
  let posBPda: PublicKey;

  it("setup: airdrops + mint + ATAs + mint balances", async () => {
    const walletBal = await provider.connection.getBalance(
      wallet.publicKey,
      "confirmed"
    );
    if (walletBal < 0.5 * LAMPORTS_PER_SOL) {
      await airdrop(wallet.publicKey, 2);
    }

    await airdrop(userA.publicKey, 2);
    await airdrop(userB.publicKey, 2);

    collateralMint = await createMint(
      provider.connection,
      payer,
      wallet.publicKey, // mint authority pubkey
      null,
      6
    );

    authorityAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        collateralMint,
        wallet.publicKey
      )
    ).address;

    userAAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        collateralMint,
        userA.publicKey
      )
    ).address;

    userBAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        payer,
        collateralMint,
        userB.publicKey
      )
    ).address;

    // Mint collateral (payer is the mint authority signer)
    await mintTo(
      provider.connection,
      payer,
      collateralMint,
      authorityAta,
      payer,
      10_000_000_000
    );
    await mintTo(
      provider.connection,
      payer,
      collateralMint,
      userAAta,
      payer,
      2_000_000_000
    );
    await mintTo(
      provider.connection,
      payer,
      collateralMint,
      userBAta,
      payer,
      2_000_000_000
    );

    const authAcc = await getAccount(provider.connection, authorityAta);
    expect(safeNumber(authAcc.amount, "authority mint balance")).to.be.greaterThan(
      0
    );
  });

  it("derive PDAs (market, vault, vault authority, positions)", async () => {
    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_v2"), wallet.publicKey.toBuffer(), u64LE(marketId)],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_v2"), marketPda.toBuffer()],
      program.programId
    );

    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth_v2"), marketPda.toBuffer()],
      program.programId
    );

    [posAPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position_v2"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
      ],
      program.programId
    );

    [posBPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position_v2"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
      ],
      program.programId
    );

    expect(marketPda).to.not.eq(undefined);
    expect(vaultPda).to.not.eq(undefined);
    expect(vaultAuthPda).to.not.eq(undefined);
  });

  it("create_market_cpmm: creates market + PDA vault token account + deposits backing", async () => {
    const endTime = new anchor.BN(Math.floor(Date.now() / 1000) + 24 * 3600); // 24h
    const backing = initialLiquidity.mul(new anchor.BN(2));

    const authAcc = await getAccount(provider.connection, authorityAta);
    const backingAmt = safeNumber(backing, "backing");
    const authAmt = safeNumber(authAcc.amount, "authority ATA amount");
    if (authAmt < backingAmt) {
      throw new Error(`Insufficient collateral: have=${authAmt} need=${backingAmt}`);
    }

    await program.methods
      .createMarketCpmm({
        marketId,
        question: "Will BTC be above 100k on Jan 1 2027?",
        endTime,
        initialLiquidity,
      })
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        collateralMint,
        authority: wallet.publicKey,
        authorityCollateralAta: authorityAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc({ commitment: "confirmed" });

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.authority.toBase58()).to.eq(wallet.publicKey.toBase58());
    expect(market.vault.toBase58()).to.eq(vaultPda.toBase58());
    expect(market.status).to.eq(0); // Open

    const vaultAcc = await waitForTokenAccount(vaultPda);
    expect(safeNumber(vaultAcc.amount, "vault amount after create")).to.eq(
      backingAmt
    );
  });

  it("buy_shares: userA buys YES, userB buys YES (fee-aware vault deltas + sanity)", async () => {
    // Ensure vault exists (create_market must have succeeded)
    await waitForTokenAccount(vaultPda);

    const aIn = new anchor.BN(200_000_000); // 200.000000 gross
    const bIn = new anchor.BN(400_000_000); // 400.000000 gross
    const minSharesOut = new anchor.BN(1);

    const vaultBefore = await getAccount(provider.connection, vaultPda);
    const aBefore = await getAccount(provider.connection, userAAta);
    const bBefore = await getAccount(provider.connection, userBAta);

    await program.methods
      .buyShares(0, aIn, minSharesOut) // 0=YES
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: posAPda,
        user: userA.publicKey,
        userCollateralAta: userAAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([userA])
      .rpc({ commitment: "confirmed" });

    await program.methods
      .buyShares(0, bIn, minSharesOut) // 0=YES
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: posBPda,
        user: userB.publicKey,
        userCollateralAta: userBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([userB])
      .rpc({ commitment: "confirmed" });

    const vaultAfter = await getAccount(provider.connection, vaultPda);
    const aAfter = await getAccount(provider.connection, userAAta);
    const bAfter = await getAccount(provider.connection, userBAta);

    // Vault increases by gross deposits
    expect(safeNumber(vaultAfter.amount, "vaultAfter") - safeNumber(vaultBefore.amount, "vaultBefore"))
      .to.eq(safeNumber(aIn, "aIn") + safeNumber(bIn, "bIn"));

    // Users decrease by gross spend
    expect(safeNumber(aBefore.amount, "aBefore") - safeNumber(aAfter.amount, "aAfter"))
      .to.eq(safeNumber(aIn, "aIn"));
    expect(safeNumber(bBefore.amount, "bBefore") - safeNumber(bAfter.amount, "bAfter"))
      .to.eq(safeNumber(bIn, "bIn"));

    // Sanity: net-in is less than gross-in due to fee
    expect(netInFromGross(safeNumber(aIn, "aIn"))).to.be.lessThan(safeNumber(aIn, "aIn"));
    expect(netInFromGross(safeNumber(bIn, "bIn"))).to.be.lessThan(safeNumber(bIn, "bIn"));

    const posA = await program.account.positionV2.fetch(posAPda);
    const posB = await program.account.positionV2.fetch(posBPda);

    expect(Number(posA.yesShares)).to.be.greaterThan(0);
    expect(Number(posB.yesShares)).to.be.greaterThan(0);
  });

  it("sell_shares: userA sells half YES before resolution (balance increases + fee sanity)", async () => {
    const posABefore = await program.account.positionV2.fetch(posAPda);
    const sellSharesIn = new anchor.BN(
      Math.floor(Number(posABefore.yesShares) / 2)
    );
    expect(Number(sellSharesIn)).to.be.greaterThan(0);

    const minOut = new anchor.BN(1);

    const userBefore = await getAccount(provider.connection, userAAta);
    const vaultBefore = await getAccount(provider.connection, vaultPda);

    await program.methods
      .sellShares(0, sellSharesIn, minOut)
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: posAPda,
        user: userA.publicKey,
        userCollateralAta: userAAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc({ commitment: "confirmed" });

    const posAAfter = await program.account.positionV2.fetch(posAPda);
    expect(Number(posAAfter.yesShares)).to.eq(
      Number(posABefore.yesShares) - Number(sellSharesIn)
    );

    const userAfter = await getAccount(provider.connection, userAAta);
    const vaultAfter = await getAccount(provider.connection, vaultPda);

    // User received some collateral
    expect(safeNumber(userAfter.amount, "userAfter")).to.be.greaterThan(
      safeNumber(userBefore.amount, "userBefore")
    );

    // Vault paid out something (net out). Fee stays, so vault decreases, but not by gross_out.
    expect(safeNumber(vaultAfter.amount, "vaultAfter")).to.be.lessThan(
      safeNumber(vaultBefore.amount, "vaultBefore")
    );

    // Fee sanity check: vault should retain at least 0 (trivial) and fee computed on some gross_out
    // We can't observe gross_out directly without redoing CPMM math here, but we can at least assert:
    // user delta < vault delta magnitude (because fee is retained)
    const userDelta =
      safeNumber(userAfter.amount, "userAfter") -
      safeNumber(userBefore.amount, "userBefore");
    const vaultDelta =
      safeNumber(vaultBefore.amount, "vaultBefore") -
      safeNumber(vaultAfter.amount, "vaultAfter"); // positive

    expect(userDelta).to.be.greaterThan(0);
    expect(vaultDelta).to.be.greaterThan(0);
    expect(userDelta).to.be.lessThanOrEqual(vaultDelta); // fee kept => vault pays >= user receives
  });

  it("resolve_market: authority resolves YES", async () => {
    await program.methods
      .resolveMarket(0)
      .accounts({
        market: marketPda,
        vault: vaultPda, // NEW: required for snapshot
        authority: wallet.publicKey,
      })
      .rpc({ commitment: "confirmed" });

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.status).to.eq(1); // Resolved
    expect(market.winningOutcome).to.eq(0);

    // NEW: ensure snapshots got populated
    expect(Number(market.resolvedVaultBalance)).to.be.greaterThan(0);
    expect(Number(market.resolvedTotalWinningShares)).to.be.greaterThan(0);
  });


  it("claim_winnings_v2: classic pro-rata payout (order-independent) + invariants", async () => {
    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.status).to.eq(1);
    expect(market.winningOutcome).to.eq(0);

    const snapshotVault = safeNumber(market.resolvedVaultBalance, "resolvedVaultBalance");
    const snapshotTotal = safeNumber(market.resolvedTotalWinningShares, "resolvedTotalWinningShares");

    expect(snapshotVault).to.be.greaterThan(0);
    expect(snapshotTotal).to.be.greaterThan(0);

    const userABefore = safeNumber((await getAccount(provider.connection, userAAta)).amount, "userABefore");
    const userBBefore = safeNumber((await getAccount(provider.connection, userBAta)).amount, "userBBefore");

    const posA = await program.account.positionV2.fetch(posAPda);
    const posB = await program.account.positionV2.fetch(posBPda);

    const aShares = safeNumber(posA.yesShares, "posA.yesShares");
    const bShares = safeNumber(posB.yesShares, "posB.yesShares");

    const expectedA = proRataPayoutFloor(snapshotVault, aShares, snapshotTotal);
    const expectedB = proRataPayoutFloor(snapshotVault, bShares, snapshotTotal);

    await program.methods
      .claimWinningsV2()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: posAPda,
        user: userA.publicKey,
        userCollateralAta: userAAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userA])
      .rpc({ commitment: "confirmed" });

    await program.methods
      .claimWinningsV2()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: posBPda,
        user: userB.publicKey,
        userCollateralAta: userBAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userB])
      .rpc({ commitment: "confirmed" });

    const userAAfter = safeNumber((await getAccount(provider.connection, userAAta)).amount, "userAAfter");
    const userBAfter = safeNumber((await getAccount(provider.connection, userBAta)).amount, "userBAfter");

    const actualA = userAAfter - userABefore;
    const actualB = userBAfter - userBBefore;

    expect(actualA).to.eq(expectedA);
    expect(actualB).to.eq(expectedB);

    // Claimed flags
    const posAAfter = await program.account.positionV2.fetch(posAPda);
    const posBAfter = await program.account.positionV2.fetch(posBPda);
    expect(posAAfter.claimed).to.eq(true);
    expect(posBAfter.claimed).to.eq(true);

    // Shares unchanged by claim
    expect(Number(posAAfter.yesShares)).to.eq(Number(posA.yesShares));
    expect(Number(posBAfter.yesShares)).to.eq(Number(posB.yesShares));

    // Vault decreased by sum of payouts
    const vaultEnd = safeNumber((await getAccount(provider.connection, vaultPda)).amount, "vaultEnd");
    const vaultNowPaid = snapshotVault - vaultEnd;
    expect(vaultNowPaid).to.eq(actualA + actualB);
  });

});
