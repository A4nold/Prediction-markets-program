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

// Update this to match your generated IDL type name
import { PredictionProgramV2 } from "../target/types/prediction_program_v2";

describe("prediction_program_v2 (CPMM + fees + pro-rata) e2e", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PredictionProgramV2 as Program<PredictionProgramV2>;

  const wallet = provider.wallet as anchor.Wallet;

  const initialLiquidity = new anchor.BN(1_000_000_000); // 1000.000000

  // Two traders
  const userA = anchor.web3.Keypair.generate();
  const userB = anchor.web3.Keypair.generate();

  // Mint + token accounts
  let collateralMint: PublicKey;
  let authorityAta: PublicKey;
  let userAAta: PublicKey;
  let userBAta: PublicKey;

  // PDAs
  const marketId = new anchor.BN(1);
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let posAPda: PublicKey;
  let posBPda: PublicKey;

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  function u64LE(n: anchor.BN) {
    return n.toArrayLike(Buffer, "le", 8);
  }

  it("setup: airdrops + mint + ATAs + mint balances", async () => {
    await airdrop(wallet.publicKey, 2);
    await airdrop(userA.publicKey, 2);
    await airdrop(userB.publicKey, 2);

    collateralMint = await createMint(
      provider.connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6
    );

    const authorityAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      collateralMint,
      wallet.publicKey
    );
    authorityAta = authorityAtaAcc.address;

    const userAAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      collateralMint,
      userA.publicKey
    );
    userAAta = userAAtaAcc.address;

    const userBAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      collateralMint,
      userB.publicKey
    );
    userBAta = userBAtaAcc.address;

    // Authority funds the vault backing. Give authority plenty.
    await mintTo(
      provider.connection,
      wallet.payer,
      collateralMint,
      authorityAta,
      wallet.payer,
      10_000_000_000 // 10,000.000000
    );

    // Give users starting collateral
    await mintTo(
      provider.connection,
      wallet.payer,
      collateralMint,
      userAAta,
      wallet.payer,
      2_000_000_000 // 2,000.000000
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      collateralMint,
      userBAta,
      wallet.payer,
      2_000_000_000 // 2,000.000000
    );

    const authBal = await provider.connection.getTokenAccountBalance(
      authorityAta
    );
    expect(authBal.value.uiAmount).to.be.greaterThan(0);
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
    // Give yourself plenty of time so tests don’t flake on slow builds.
    const endTime = new anchor.BN(Math.floor(Date.now() / 1000) + 24 * 3600); // 24h

    const backing = initialLiquidity.mul(new anchor.BN(2));

    await program.methods
      .createMarketCpmm({
        marketId: marketId, // Anchor IDL sometimes expects number for u64; if this fails, use marketId: marketId
        question: "Will BTC be above 100k on Jan 1 2027?",
        endTime,
        initialLiquidity,
      } as any)
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
      } as any)
      .rpc();

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.authority.toBase58()).to.eq(wallet.publicKey.toBase58());
    expect(market.vault.toBase58()).to.eq(vaultPda.toBase58());
    expect(market.status).to.eq(0); // Open

    const vaultAcc = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAcc.amount)).to.eq(Number(backing));
  });

  it("buy_shares: userA buys YES, userB buys YES (fee-aware vault deltas)", async () => {
    const aIn = new anchor.BN(200_000_000); // 200.000000
    const bIn = new anchor.BN(400_000_000); // 400.000000
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
      } as any)
      .signers([userA])
      .rpc();

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
      } as any)
      .signers([userB])
      .rpc();

    const vaultAfter = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAfter.amount)).to.eq(
      Number(initialLiquidity.mul(new anchor.BN(2)).add(aIn).add(bIn))
    );
    const aAfter = await getAccount(provider.connection, userAAta);
    const bAfter = await getAccount(provider.connection, userBAta);

    // Gross transfers: vault increases by aIn + bIn, users decrease by their gross spend
    expect(Number(vaultAfter.amount) - Number(vaultBefore.amount)).to.eq(
      Number(aIn.add(bIn))
    );
    expect(Number(aBefore.amount) - Number(aAfter.amount)).to.eq(Number(aIn));
    expect(Number(bBefore.amount) - Number(bAfter.amount)).to.eq(Number(bIn));

    const posA = await program.account.positionV2.fetch(posAPda);
    const posB = await program.account.positionV2.fetch(posBPda);

    expect(Number(posA.yesShares)).to.be.greaterThan(0);
    expect(Number(posB.yesShares)).to.be.greaterThan(0);
  });

  it("sell_shares: userA sells half YES before resolution (balance increases)", async () => {
    const posABefore = await program.account.positionV2.fetch(posAPda);
    const sellSharesIn = new anchor.BN(
      Math.floor(Number(posABefore.yesShares) / 2)
    );
    expect(Number(sellSharesIn)).to.be.greaterThan(0);

    const minOut = new anchor.BN(1);

    const userBefore = await getAccount(provider.connection, userAAta);

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
      } as any)
      .signers([userA])
      .rpc();

    const posAAfter = await program.account.positionV2.fetch(posAPda);
    expect(Number(posAAfter.yesShares)).to.eq(
      Number(posABefore.yesShares) - Number(sellSharesIn)
    );

    const userAfter = await getAccount(provider.connection, userAAta);
    expect(Number(userAfter.amount)).to.be.greaterThan(
      Number(userBefore.amount)
    );
  });

  it("resolve_market: authority resolves YES", async () => {
    await program.methods
      .resolveMarket(0)
      .accounts({
        market: marketPda,
        authority: wallet.publicKey,
      })
      .rpc();

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.status).to.eq(1); // Resolved
    expect(market.winningOutcome).to.eq(0);
  });

  it("claim_winnings_v2: pro-rata payout for both users (and claimed flag)", async () => {
    const posABefore = await program.account.positionV2.fetch(posAPda);
    const posBBefore = await program.account.positionV2.fetch(posBPda);

    // If a user has 0 winning shares, claim should fail (NoWinnings)
    async function claimOrExpectFail(
      user: anchor.web3.Keypair,
      userAta: PublicKey,
      posPda: PublicKey
    ) {
      const pos = await program.account.positionV2.fetch(posPda);
      const hasWinningShares = Number(pos.yesShares) > 0;

      if (!hasWinningShares) {
        let failed = false;
        try {
          await program.methods
            .claimWinningsV2()
            .accounts({
              market: marketPda,
              vault: vaultPda,
              vaultAuthority: vaultAuthPda,
              position: posPda,
              user: user.publicKey,
              userCollateralAta: userAta,
              tokenProgram: TOKEN_PROGRAM_ID,
            } as any)
            .signers([user])
            .rpc();
        } catch (e) {
          failed = true;
        }
        expect(failed).to.eq(true);
        return;
      }

      const userBefore = await getAccount(provider.connection, userAta);
      const vaultBefore = await getAccount(provider.connection, vaultPda);

      await program.methods
        .claimWinningsV2()
        .accounts({
          market: marketPda,
          vault: vaultPda,
          vaultAuthority: vaultAuthPda,
          position: posPda,
          user: user.publicKey,
          userCollateralAta: userAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([user])
        .rpc();

      const userAfter = await getAccount(provider.connection, userAta);
      const vaultAfter = await getAccount(provider.connection, vaultPda);
      const posAfter = await program.account.positionV2.fetch(posPda);

      expect(posAfter.claimed).to.eq(true);
      expect(Number(userAfter.amount)).to.be.greaterThan(
        Number(userBefore.amount)
      );
      expect(Number(vaultAfter.amount)).to.be.lessThan(
        Number(vaultBefore.amount)
      );
    }

    // Claim for both users
    await claimOrExpectFail(userA, userAAta, posAPda);
    await claimOrExpectFail(userB, userBAta, posBPda);

    // Optional: basic sanity that at least one of them had shares and claimed
    const posAAfter = await program.account.positionV2.fetch(posAPda);
    const posBAfter = await program.account.positionV2.fetch(posBPda);

    expect(posAAfter.claimed || posBAfter.claimed).to.eq(true);

    // And positions should not magically change share counts during claim
    expect(Number(posAAfter.yesShares)).to.eq(Number(posABefore.yesShares));
    expect(Number(posBAfter.yesShares)).to.eq(Number(posBBefore.yesShares));
  });
});
