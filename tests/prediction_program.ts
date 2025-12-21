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

// Change this import path/name to match your generated IDL type.
// If your program crate is `prediction_program_v2`, Anchor usually generates:
// target/types/prediction_program_v2.ts
import { PredictionProgramV2 } from "../target/types/prediction_program";

describe("prediction_program_v2 (CPMM) e2e", () => {
  // Provider from env: ANCHOR_PROVIDER_URL + wallet keypair
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .PredictionProgramV2 as Program<PredictionProgramV2>;
  const wallet = provider.wallet as anchor.Wallet;

  // Test actors
  const user = anchor.web3.Keypair.generate();

  // Mint + token accounts
  let collateralMint: PublicKey;
  let authorityAta: PublicKey;
  let userAta: PublicKey;

  // PDAs
  const marketId = new anchor.BN(1);
  let marketPda: PublicKey;
  let vaultPda: PublicKey;
  let vaultAuthPda: PublicKey;
  let positionPda: PublicKey;

  const toU64 = (n: number) => new anchor.BN(n);

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  it("setup: airdrop + create mint + ATAs + mint balances", async () => {
    // Fund authority + user for rent/fees
    await airdrop(wallet.publicKey, 2);
    await airdrop(user.publicKey, 2);

    // Create a fake USDC mint (6 decimals)
    collateralMint = await createMint(
      provider.connection,
      wallet.payer, // payer
      wallet.publicKey, // mint authority
      null, // freeze authority
      6
    );

    // Authority ATA
    const authorityAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      collateralMint,
      wallet.publicKey
    );
    authorityAta = authorityAtaAcc.address;

    // User ATA
    const userAtaAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      wallet.payer,
      collateralMint,
      user.publicKey
    );
    userAta = userAtaAcc.address;

    // Mint collateral to authority and user
    await mintTo(
      provider.connection,
      wallet.payer,
      collateralMint,
      authorityAta,
      wallet.payer,
      5_000_000_000 // 5000.000000
    );

    await mintTo(
      provider.connection,
      wallet.payer,
      collateralMint,
      userAta,
      wallet.payer,
      2_000_000_000 // 2000.000000
    );

    const authBal = await provider.connection.getTokenAccountBalance(
      authorityAta
    );
    const userBal = await provider.connection.getTokenAccountBalance(userAta);

    expect(authBal.value.uiAmount).to.be.greaterThan(0);
    expect(userBal.value.uiAmount).to.be.greaterThan(0);
  });

  it("derive PDAs (market, vault, vault authority, position)", async () => {
    // market PDA seed:
    // [b"market_v2", authority.key().as_ref(), &market_id.to_le_bytes()]
    const marketIdLE = marketId.toArrayLike(Buffer, "le", 8);

    [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("market_v2"), wallet.publicKey.toBuffer(), marketIdLE],
      program.programId
    );

    // vault PDA seed:
    // [b"vault_v2", market.key().as_ref()]
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_v2"), marketPda.toBuffer()],
      program.programId
    );

    // vault authority PDA seed:
    // [b"vault_auth_v2", market.key().as_ref()]
    [vaultAuthPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_auth_v2"), marketPda.toBuffer()],
      program.programId
    );

    // position PDA seed:
    // [b"position_v2", market.key().as_ref(), user.key().as_ref()]
    [positionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("position_v2"),
        marketPda.toBuffer(),
        user.publicKey.toBuffer(),
      ],
      program.programId
    );

    expect(marketPda).to.not.eq(undefined);
    expect(vaultPda).to.not.eq(undefined);
    expect(vaultAuthPda).to.not.eq(undefined);
    expect(positionPda).to.not.eq(undefined);
  });

  it("create_market_cpmm (creates market + vault and deposits backing)", async () => {
    const endTime = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour
    const initialLiquidity = new anchor.BN(1_000_000_000); // 1000.000000 collateral units

    // Before: read vault existence (should not exist yet)
    // If it errors, that’s fine — we’re about to create it.

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
      .rpc();

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.authority.toBase58()).to.eq(wallet.publicKey.toBase58());
    expect(market.vault.toBase58()).to.eq(vaultPda.toBase58());
    expect(market.status).to.eq(0); // Open

    // Vault should now exist and be funded with 2 * initialLiquidity
    const vaultAcc = await getAccount(provider.connection, vaultPda);
    expect(Number(vaultAcc.amount)).to.eq(
      Number(initialLiquidity.mul(new anchor.BN(2)))
    );
  });

  it("buy_shares (user buys YES)", async () => {
    const maxCollateralIn = new anchor.BN(200_000_000); // 200.000000
    const minSharesOut = new anchor.BN(1); // low for test

    const userBefore = await getAccount(provider.connection, userAta);
    const vaultBefore = await getAccount(provider.connection, vaultPda);

    await program.methods
      .buyShares(0, maxCollateralIn, minSharesOut) // 0 = YES
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: positionPda,
        user: user.publicKey,
        userCollateralAta: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.positionV2.fetch(positionPda);
    expect(Number(pos.yesShares)).to.be.greaterThan(0);

    const userAfter = await getAccount(provider.connection, userAta);
    const vaultAfter = await getAccount(provider.connection, vaultPda);

    // User spent maxCollateralIn (gross), vault gained it
    expect(Number(userBefore.amount) - Number(userAfter.amount)).to.eq(
      Number(maxCollateralIn)
    );
    expect(Number(vaultAfter.amount) - Number(vaultBefore.amount)).to.eq(
      Number(maxCollateralIn)
    );
  });

  it("sell_shares (user sells some YES before resolution)", async () => {
    const posBefore = await program.account.positionV2.fetch(positionPda);
    const sellSharesIn = new anchor.BN(
      Math.floor(Number(posBefore.yesShares) / 2)
    );
    expect(Number(sellSharesIn)).to.be.greaterThan(0);

    const minCollateralOut = new anchor.BN(1); // low for test

    const userBefore = await getAccount(provider.connection, userAta);

    await program.methods
      .sellShares(0, sellSharesIn, minCollateralOut) // 0 = YES
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: positionPda,
        user: user.publicKey,
        userCollateralAta: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const posAfter = await program.account.positionV2.fetch(positionPda);
    expect(Number(posAfter.yesShares)).to.eq(
      Number(posBefore.yesShares) - Number(sellSharesIn)
    );

    const userAfter = await getAccount(provider.connection, userAta);
    expect(Number(userAfter.amount)).to.be.greaterThan(
      Number(userBefore.amount)
    ); // received some collateral back
  });

  it("resolve_market (authority resolves YES)", async () => {
    await program.methods
      .resolveMarket(0) // YES wins
      .accounts({
        market: marketPda,
        authority: wallet.publicKey,
      })
      .rpc();

    const market = await program.account.marketV2.fetch(marketPda);
    expect(market.status).to.eq(1); // Resolved
    expect(market.winningOutcome).to.eq(0);
  });

  it("claim_winnings_v2 (pro-rata payout)", async () => {
    const userBefore = await getAccount(provider.connection, userAta);
    const vaultBefore = await getAccount(provider.connection, vaultPda);

    await program.methods
      .claimWinningsV2()
      .accounts({
        market: marketPda,
        vault: vaultPda,
        vaultAuthority: vaultAuthPda,
        position: positionPda,
        user: user.publicKey,
        userCollateralAta: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const pos = await program.account.positionV2.fetch(positionPda);
    expect(pos.claimed).to.eq(true);

    const userAfter = await getAccount(provider.connection, userAta);
    const vaultAfter = await getAccount(provider.connection, vaultPda);

    // User should receive something (if they still had winning shares)
    expect(Number(userAfter.amount)).to.be.greaterThan(
      Number(userBefore.amount)
    );

    // Vault should decrease by payout
    expect(Number(vaultAfter.amount)).to.be.lessThan(
      Number(vaultBefore.amount)
    );
  });
});
