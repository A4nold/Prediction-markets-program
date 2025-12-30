use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("7zGEj8SHZ6bDzfFJwfJxSZWvyMEoXtX5nTf6Wk4vFzj5"); // TODO: replace after deploy

// ----------------------------
// Config
// ----------------------------
pub const FEE_BPS: u64 = 50; // 0.50% fee
pub const BPS_DENOM: u64 = 10_000;

#[program]
pub mod prediction_program_v2 {
  use super::*;

  /// Create a new YES/NO CPMM market.
  ///
  /// - Market account is a PDA derived from (authority, market_id)
  /// - Vault token account is a PDA owned by vault_authority PDA
  /// - Authority funds the vault with initial liquidity backing
  pub fn create_market_cpmm(
    ctx: Context<CreateMarketCpmm>,
    args: CreateMarketCpmmArgs,
  ) -> Result<()> {
    require!(args.initial_liquidity > 0, PredictionError::InvalidLiquidity);

    let market = &mut ctx.accounts.market;

    market.market_id = args.market_id;
    market.authority = ctx.accounts.authority.key();
    market.question = args.question;
    market.collateral_mint = ctx.accounts.collateral_mint.key();
    market.vault = ctx.accounts.vault.key();
    market.end_time = args.end_time;
    market.status = MarketStatus::Open as u8;
    market.winning_outcome = -1;

    // Symmetric initial reserves. These reserves are in "collateral units".
    // We back them by depositing 2*L collateral into the vault.
    market.yes_pool = args.initial_liquidity;
    market.no_pool = args.initial_liquidity;

    market.total_yes_shares = 0;
    market.total_no_shares = 0;

    // CLASSIC PRO-RATA: init snapshots to 0
    market.resolved_vault_balance = 0;
    market.resolved_total_winning_shares = 0;

    // Deposit 2*L collateral into vault as backing.
    let backing = args
      .initial_liquidity
      .checked_mul(2)
      .ok_or(PredictionError::MathOverflow)?;

    let cpi_accounts = Transfer {
      from: ctx.accounts.authority_collateral_ata.to_account_info(),
      to: ctx.accounts.vault.to_account_info(),
      authority: ctx.accounts.authority.to_account_info(),
    };

    token::transfer(
      CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
      backing,
    )?;

    Ok(())
  }

  /// Buy YES (0) or NO (1) shares by paying collateral.
  ///
  /// Fee is taken from the input collateral (gross_in).
  /// Swap is computed on net_in to protect the pool.
  pub fn buy_shares(
    ctx: Context<BuyShares>,
    outcome_index: u8,
    max_collateral_in: u64,
    min_shares_out: u64, // slippage guard (recommended)
  ) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(
      market.status == MarketStatus::Open as u8,
      PredictionError::InvalidMarketStatus
    );

    let clock = Clock::get()?;
    require!(
      clock.unix_timestamp < market.end_time,
      PredictionError::MarketExpired
    );

    require!(outcome_index <= 1, PredictionError::InvalidOutcome);
    require!(max_collateral_in > 0, PredictionError::ZeroAmount);

    // Fee on input
    let (net_in, _fee) = apply_fee_in(max_collateral_in)?;

    // CPMM buy using net_in
    let (new_yes, new_no, shares_out) = match outcome_index {
      0 => cpmm_buy_yes(market.yes_pool, market.no_pool, net_in)?,
      1 => cpmm_buy_no(market.yes_pool, market.no_pool, net_in)?,
      _ => return err!(PredictionError::InvalidOutcome),
    };

    require!(shares_out >= min_shares_out, PredictionError::SlippageExceeded);
    require!(shares_out > 0, PredictionError::ZeroSharesOut);

    // Transfer gross collateral to vault; fee stays inside vault.
    let cpi_accounts = Transfer {
      from: ctx.accounts.user_collateral_ata.to_account_info(),
      to: ctx.accounts.vault.to_account_info(),
      authority: ctx.accounts.user.to_account_info(),
    };

    token::transfer(
      CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
      max_collateral_in,
    )?;

    // Update reserves
    market.yes_pool = new_yes;
    market.no_pool = new_no;

    // Init/update position
    let position = &mut ctx.accounts.position;

    // Fresh position
    if position.owner == Pubkey::default() {
      position.market = market.key();
      position.owner = ctx.accounts.user.key();
      position.yes_shares = 0;
      position.no_shares = 0;
      position.claimed = false;
    } else {
      require!(
        position.market == market.key(),
        PredictionError::PositionMarketMismatch
      );
      require!(
        position.owner == ctx.accounts.user.key(),
        PredictionError::PositionOwnerMismatch
      );
    }

    match outcome_index {
      0 => {
        position.yes_shares = position
          .yes_shares
          .checked_add(shares_out)
          .ok_or(PredictionError::MathOverflow)?;
        market.total_yes_shares = market
          .total_yes_shares
          .checked_add(shares_out)
          .ok_or(PredictionError::MathOverflow)?;
      }
      1 => {
        position.no_shares = position
          .no_shares
          .checked_add(shares_out)
          .ok_or(PredictionError::MathOverflow)?;
        market.total_no_shares = market
          .total_no_shares
          .checked_add(shares_out)
          .ok_or(PredictionError::MathOverflow)?;
      }
      _ => unreachable!(),
    }

    Ok(())
  }

  /// Sell YES (0) or NO (1) shares back to the AMM for collateral.
  ///
  /// Fee is taken from the output collateral.
  /// The fee stays in the vault, effectively increasing solvency over time.
  pub fn sell_shares(
    ctx: Context<SellShares>,
    outcome_index: u8,
    shares_in: u64,
    min_collateral_out: u64, // slippage guard
  ) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    require!(
      market.status == MarketStatus::Open as u8,
      PredictionError::InvalidMarketStatus
    );

    let clock = Clock::get()?;
    require!(
      clock.unix_timestamp < market.end_time,
      PredictionError::MarketExpired
    );

    require!(outcome_index <= 1, PredictionError::InvalidOutcome);
    require!(shares_in > 0, PredictionError::ZeroAmount);

    require!(
      position.market == market.key(),
      PredictionError::PositionMarketMismatch
    );
    require!(
      position.owner == ctx.accounts.user.key(),
      PredictionError::PositionOwnerMismatch
    );
    require!(!position.claimed, PredictionError::AlreadyClaimed);

    // Ensure user has shares
    match outcome_index {
      0 => require!(
        position.yes_shares >= shares_in,
        PredictionError::InsufficientShares
      ),
      1 => require!(
        position.no_shares >= shares_in,
        PredictionError::InsufficientShares
      ),
      _ => return err!(PredictionError::InvalidOutcome),
    }

    // Compute gross collateral out by CPMM
    let (new_yes, new_no, gross_out) = match outcome_index {
      0 => cpmm_sell_yes(market.yes_pool, market.no_pool, shares_in)?,
      1 => cpmm_sell_no(market.yes_pool, market.no_pool, shares_in)?,
      _ => return err!(PredictionError::InvalidOutcome),
    };

    require!(gross_out > 0, PredictionError::ZeroAmount);

    // Fee on output; user receives net_out
    let (net_out, _fee) = apply_fee_out(gross_out)?;
    require!(net_out >= min_collateral_out, PredictionError::SlippageExceeded);

    // Update reserves (see comment in your original code)
    market.yes_pool = new_yes;
    market.no_pool = new_no;

    // Adjust reserve to account for fee retention
    let fee_kept = gross_out
      .checked_sub(net_out)
      .ok_or(PredictionError::MathOverflow)?;
    if fee_kept > 0 {
      match outcome_index {
        0 => {
          market.no_pool = market
            .no_pool
            .checked_add(fee_kept)
            .ok_or(PredictionError::MathOverflow)?;
        }
        1 => {
          market.yes_pool = market
            .yes_pool
            .checked_add(fee_kept)
            .ok_or(PredictionError::MathOverflow)?;
        }
        _ => {}
      }
    }

    // Burn shares from position and totals
    match outcome_index {
      0 => {
        position.yes_shares = position
          .yes_shares
          .checked_sub(shares_in)
          .ok_or(PredictionError::MathOverflow)?;
        market.total_yes_shares = market
          .total_yes_shares
          .checked_sub(shares_in)
          .ok_or(PredictionError::MathOverflow)?;
      }
      1 => {
        position.no_shares = position
          .no_shares
          .checked_sub(shares_in)
          .ok_or(PredictionError::MathOverflow)?;
        market.total_no_shares = market
          .total_no_shares
          .checked_sub(shares_in)
          .ok_or(PredictionError::MathOverflow)?;
      }
      _ => unreachable!(),
    }

    // Transfer net_out from vault to user using PDA vault authority signer
    let binding = market.key();
    let seeds: &[&[u8]] = &[
      b"vault_auth_v2",
      binding.as_ref(),
      &[ctx.bumps.vault_authority],
    ];

    let cpi_accounts = Transfer {
      from: ctx.accounts.vault.to_account_info(),
      to: ctx.accounts.user_collateral_ata.to_account_info(),
      authority: ctx.accounts.vault_authority.to_account_info(),
    };

    token::transfer(
      CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &[seeds],
      ),
      net_out,
    )?;

    Ok(())
  }

  /// Resolve market with winning outcome (0 = YES, 1 = NO).
  ///
  /// CLASSIC PRO-RATA:
  /// - snapshot vault amount and total winning shares at resolution
  /// - claims compute against snapshot (order independent)
  pub fn resolve_market(ctx: Context<ResolveMarketV2>, winning_outcome: u8) -> Result<()> {
    let market = &mut ctx.accounts.market;

    require!(
      ctx.accounts.authority.key() == market.authority,
      PredictionError::Unauthorized
    );
    require!(
      market.status == MarketStatus::Open as u8,
      PredictionError::InvalidMarketStatus
    );
    require!(winning_outcome <= 1, PredictionError::InvalidOutcome);

    let total_winning_shares = match winning_outcome {
      0 => market.total_yes_shares,
      1 => market.total_no_shares,
      _ => return err!(PredictionError::InvalidOutcome),
    };
    require!(total_winning_shares > 0, PredictionError::NoWinnings);

    // Snapshot at resolution time
    market.resolved_vault_balance = ctx.accounts.vault.amount;
    market.resolved_total_winning_shares = total_winning_shares;

    market.status = MarketStatus::Resolved as u8;
    market.winning_outcome = winning_outcome as i8;

    Ok(())
  }

  /// Claim winnings after resolution using classic pro-rata payout from snapshot.
  ///
  /// payout = resolved_vault_balance * user_winning_shares / resolved_total_winning_shares
  pub fn claim_winnings_v2(ctx: Context<ClaimWinningsV2>) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.position;

    require!(
      market.status == MarketStatus::Resolved as u8,
      PredictionError::MarketNotResolved
    );

    let winning = market.winning_outcome;
    require!(winning >= 0, PredictionError::InvalidWinningOutcome);

    require!(!position.claimed, PredictionError::AlreadyClaimed);
    require!(
      position.market == market.key(),
      PredictionError::PositionMarketMismatch
    );
    require!(
      position.owner == ctx.accounts.user.key(),
      PredictionError::PositionOwnerMismatch
    );

    // CLASSIC PRO-RATA: use snapshots
    let total_winning_shares = market.resolved_total_winning_shares;
    let vault_balance = market.resolved_vault_balance;

    require!(total_winning_shares > 0, PredictionError::NoWinnings);
    require!(vault_balance > 0, PredictionError::NoWinnings);

    let user_winning_shares = match winning as u8 {
      0 => position.yes_shares,
      1 => position.no_shares,
      _ => return err!(PredictionError::InvalidWinningOutcome),
    };

    require!(user_winning_shares > 0, PredictionError::NoWinnings);

    let payout_u128 = (vault_balance as u128)
      .checked_mul(user_winning_shares as u128)
      .ok_or(PredictionError::MathOverflow)?
      .checked_div(total_winning_shares as u128)
      .ok_or(PredictionError::MathOverflow)?;

    let payout: u64 = payout_u128
      .try_into()
      .map_err(|_| PredictionError::MathOverflow)?;
    require!(payout > 0, PredictionError::NoWinnings);

    // Transfer payout from vault to user using PDA vault authority signer
    let binding = market.key();
    let seeds: &[&[u8]] = &[
      b"vault_auth_v2",
      binding.as_ref(),
      &[ctx.bumps.vault_authority],
    ];

    let cpi_accounts = Transfer {
      from: ctx.accounts.vault.to_account_info(),
      to: ctx.accounts.user_collateral_ata.to_account_info(),
      authority: ctx.accounts.vault_authority.to_account_info(),
    };

    token::transfer(
      CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &[seeds],
      ),
      payout,
    )?;

    position.claimed = true;

    Ok(())
  }
}

// ----------------------------
// Args / Enums
// ----------------------------
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMarketCpmmArgs {
  pub market_id: u64,
  pub question: String,
  pub end_time: i64,
  pub initial_liquidity: u64,
}

#[repr(u8)]
pub enum MarketStatus {
  Open = 0,
  Resolved = 1,
  Cancelled = 2,
}

#[account]
#[derive(InitSpace)]
pub struct MarketV2 {
  pub market_id: u64,
  pub authority: Pubkey,
  #[max_len(256)]
  pub question: String,
  pub collateral_mint: Pubkey,
  pub vault: Pubkey,
  pub end_time: i64,
  pub status: u8,
  pub winning_outcome: i8,

  // Virtual reserves (collateral units)
  pub yes_pool: u64,
  pub no_pool: u64,

  // Total outstanding shares
  pub total_yes_shares: u64,
  pub total_no_shares: u64,

  // CLASSIC PRO-RATA snapshots
  pub resolved_vault_balance: u64,
  pub resolved_total_winning_shares: u64,
}

#[account]
#[derive(InitSpace)]
pub struct PositionV2 {
  pub market: Pubkey,
  pub owner: Pubkey,
  pub yes_shares: u64,
  pub no_shares: u64,
  pub claimed: bool,
}

// ----------------------------
// Accounts
// ----------------------------

#[derive(Accounts)]
#[instruction(args: CreateMarketCpmmArgs)]
pub struct CreateMarketCpmm<'info> {
  #[account(
    init,
    payer = authority,
    space = 8 + MarketV2::INIT_SPACE,
    seeds = [b"market_v2", authority.key().as_ref(), &args.market_id.to_le_bytes()],
    bump
  )]
  pub market: Account<'info, MarketV2>,

  #[account(
    init,
    payer = authority,
    seeds = [b"vault_v2", market.key().as_ref()],
    bump,
    token::mint = collateral_mint,
    token::authority = vault_authority
  )]
  pub vault: Account<'info, TokenAccount>,

  /// CHECK: PDA that signs for vault transfers
  #[account(
    seeds = [b"vault_auth_v2", market.key().as_ref()],
    bump
  )]
  pub vault_authority: UncheckedAccount<'info>,

  pub collateral_mint: Account<'info, Mint>,

  #[account(mut)]
  pub authority: Signer<'info>,

  #[account(
    mut,
    constraint = authority_collateral_ata.mint == collateral_mint.key(),
    constraint = authority_collateral_ata.owner == authority.key(),
  )]
  pub authority_collateral_ata: Account<'info, TokenAccount>,

  pub token_program: Program<'info, Token>,
  pub system_program: Program<'info, System>,
  pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct BuyShares<'info> {
  #[account(mut)]
  pub market: Account<'info, MarketV2>,

  #[account(
    mut,
    seeds = [b"vault_v2", market.key().as_ref()],
    bump
  )]
  pub vault: Account<'info, TokenAccount>,

  /// CHECK: PDA that signs for vault transfers
  #[account(
    seeds = [b"vault_auth_v2", market.key().as_ref()],
    bump
  )]
  pub vault_authority: UncheckedAccount<'info>,

  #[account(
    init_if_needed,
    payer = user,
    space = 8 + PositionV2::INIT_SPACE,
    seeds = [b"position_v2", market.key().as_ref(), user.key().as_ref()],
    bump
  )]
  pub position: Account<'info, PositionV2>,

  #[account(mut)]
  pub user: Signer<'info>,

  #[account(
    mut,
    constraint = user_collateral_ata.mint == market.collateral_mint,
    constraint = user_collateral_ata.owner == user.key(),
  )]
  pub user_collateral_ata: Account<'info, TokenAccount>,

  pub token_program: Program<'info, Token>,
  pub system_program: Program<'info, System>,
  pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SellShares<'info> {
  #[account(mut)]
  pub market: Account<'info, MarketV2>,

  #[account(
    mut,
    seeds = [b"vault_v2", market.key().as_ref()],
    bump
  )]
  pub vault: Account<'info, TokenAccount>,

  /// CHECK: PDA that signs for vault transfers
  #[account(
    seeds = [b"vault_auth_v2", market.key().as_ref()],
    bump
  )]
  pub vault_authority: UncheckedAccount<'info>,

  #[account(
    mut,
    seeds = [b"position_v2", market.key().as_ref(), user.key().as_ref()],
    bump
  )]
  pub position: Account<'info, PositionV2>,

  #[account(mut)]
  pub user: Signer<'info>,

  #[account(
    mut,
    constraint = user_collateral_ata.mint == market.collateral_mint,
    constraint = user_collateral_ata.owner == user.key(),
  )]
  pub user_collateral_ata: Account<'info, TokenAccount>,

  pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveMarketV2<'info> {
  #[account(mut)]
  pub market: Account<'info, MarketV2>,

  // CLASSIC PRO-RATA: include vault so we can snapshot vault.amount
  #[account(
    mut,
    seeds = [b"vault_v2", market.key().as_ref()],
    bump
  )]
  pub vault: Account<'info, TokenAccount>,

  pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimWinningsV2<'info> {
  #[account(mut)]
  pub market: Account<'info, MarketV2>,

  #[account(
    mut,
    seeds = [b"vault_v2", market.key().as_ref()],
    bump
  )]
  pub vault: Account<'info, TokenAccount>,

  /// CHECK: PDA that signs for vault transfers
  #[account(
    seeds = [b"vault_auth_v2", market.key().as_ref()],
    bump
  )]
  pub vault_authority: UncheckedAccount<'info>,

  #[account(
    mut,
    seeds = [b"position_v2", market.key().as_ref(), user.key().as_ref()],
    bump
  )]
  pub position: Account<'info, PositionV2>,

  #[account(mut)]
  pub user: Signer<'info>,

  #[account(
    mut,
    constraint = user_collateral_ata.mint == market.collateral_mint,
    constraint = user_collateral_ata.owner == user.key(),
  )]
  pub user_collateral_ata: Account<'info, TokenAccount>,

  pub token_program: Program<'info, Token>,
}

// ----------------------------
// CPMM Math (swap-style)
// ----------------------------

// Buying YES: add net_in to NO reserve, take YES out.
fn cpmm_buy_yes(yes_pool: u64, no_pool: u64, net_in: u64) -> Result<(u64, u64, u64)> {
  require!(yes_pool > 0 && no_pool > 0, PredictionError::InvalidLiquidity);
  let x = yes_pool as u128;
  let y = no_pool as u128;
  let dy = net_in as u128;

  let k = x.checked_mul(y).ok_or(PredictionError::MathOverflow)?;
  let y_new = y.checked_add(dy).ok_or(PredictionError::MathOverflow)?;
  let x_new = k.checked_div(y_new).ok_or(PredictionError::MathOverflow)?;

  let out = x.checked_sub(x_new).ok_or(PredictionError::MathOverflow)?;
  let out_u64: u64 = out.try_into().map_err(|_| PredictionError::MathOverflow)?;

  Ok((
    x_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    y_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    out_u64,
  ))
}

// Buying NO: add net_in to YES reserve, take NO out.
fn cpmm_buy_no(yes_pool: u64, no_pool: u64, net_in: u64) -> Result<(u64, u64, u64)> {
  require!(yes_pool > 0 && no_pool > 0, PredictionError::InvalidLiquidity);
  let x = no_pool as u128;
  let y = yes_pool as u128;
  let dy = net_in as u128;

  let k = x.checked_mul(y).ok_or(PredictionError::MathOverflow)?;
  let y_new = y.checked_add(dy).ok_or(PredictionError::MathOverflow)?;
  let x_new = k.checked_div(y_new).ok_or(PredictionError::MathOverflow)?;

  let out = x.checked_sub(x_new).ok_or(PredictionError::MathOverflow)?;
  let out_u64: u64 = out.try_into().map_err(|_| PredictionError::MathOverflow)?;

  Ok((
    y_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    x_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    out_u64,
  ))
}

// Selling YES: add shares_in to YES reserve, take NO out.
fn cpmm_sell_yes(yes_pool: u64, no_pool: u64, shares_in: u64) -> Result<(u64, u64, u64)> {
  require!(yes_pool > 0 && no_pool > 0, PredictionError::InvalidLiquidity);
  let x = yes_pool as u128;
  let y = no_pool as u128;
  let dx = shares_in as u128;

  let k = x.checked_mul(y).ok_or(PredictionError::MathOverflow)?;
  let x_new = x.checked_add(dx).ok_or(PredictionError::MathOverflow)?;
  let y_new = k.checked_div(x_new).ok_or(PredictionError::MathOverflow)?;
  let out = y.checked_sub(y_new).ok_or(PredictionError::MathOverflow)?;

  Ok((
    x_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    y_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    out.try_into().map_err(|_| PredictionError::MathOverflow)?,
  ))
}

// Selling NO: add shares_in to NO reserve, take YES out.
fn cpmm_sell_no(yes_pool: u64, no_pool: u64, shares_in: u64) -> Result<(u64, u64, u64)> {
  require!(yes_pool > 0 && no_pool > 0, PredictionError::InvalidLiquidity);
  let x = no_pool as u128;
  let y = yes_pool as u128;
  let dx = shares_in as u128;

  let k = x.checked_mul(y).ok_or(PredictionError::MathOverflow)?;
  let x_new = x.checked_add(dx).ok_or(PredictionError::MathOverflow)?;
  let y_new = k.checked_div(x_new).ok_or(PredictionError::MathOverflow)?;
  let out = y.checked_sub(y_new).ok_or(PredictionError::MathOverflow)?;

  Ok((
    y_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    x_new.try_into().map_err(|_| PredictionError::MathOverflow)?,
    out.try_into().map_err(|_| PredictionError::MathOverflow)?,
  ))
}

// ----------------------------
// Fees
// ----------------------------
fn apply_fee_in(gross_in: u64) -> Result<(u64, u64)> {
  let fee = gross_in
    .checked_mul(FEE_BPS)
    .ok_or(PredictionError::MathOverflow)?
    .checked_div(BPS_DENOM)
    .ok_or(PredictionError::MathOverflow)?;

  let net = gross_in.checked_sub(fee).ok_or(PredictionError::MathOverflow)?;
  Ok((net, fee))
}

fn apply_fee_out(gross_out: u64) -> Result<(u64, u64)> {
  let fee = gross_out
    .checked_mul(FEE_BPS)
    .ok_or(PredictionError::MathOverflow)?
    .checked_div(BPS_DENOM)
    .ok_or(PredictionError::MathOverflow)?;

  let net = gross_out.checked_sub(fee).ok_or(PredictionError::MathOverflow)?;
  Ok((net, fee))
}

// ----------------------------
// Errors
// ----------------------------
#[error_code]
pub enum PredictionError {
  #[msg("Unauthorized")]
  Unauthorized,
  #[msg("Invalid market status for this operation")]
  InvalidMarketStatus,
  #[msg("Market has already expired")]
  MarketExpired,
  #[msg("Invalid outcome index")]
  InvalidOutcome,
  #[msg("Math overflow")]
  MathOverflow,
  #[msg("Market is not resolved")]
  MarketNotResolved,
  #[msg("Invalid winning outcome index")]
  InvalidWinningOutcome,
  #[msg("Position already claimed")]
  AlreadyClaimed,
  #[msg("No winnings available to claim")]
  NoWinnings,
  #[msg("Position market mismatch")]
  PositionMarketMismatch,
  #[msg("Position owner mismatch")]
  PositionOwnerMismatch,
  #[msg("Invalid initial liquidity")]
  InvalidLiquidity,
  #[msg("Zero amount not allowed")]
  ZeroAmount,
  #[msg("Slippage exceeded user limit")]
  SlippageExceeded,
  #[msg("Zero shares out")]
  ZeroSharesOut,
  #[msg("Insufficient shares to sell")]
  InsufficientShares,
//   #[msg("Invalid liquidity")]
//   InvalidLiquidity, // keep if you used earlier; otherwise remove duplicates
}
