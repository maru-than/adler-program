use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct MintReputation<'info> {
    /// CHECK: Brand pubkey, used as a seed for the `ContractRecord` PDA. The
    /// `seeds` constraint on `record` validates this matches the actual
    /// record's brand.
    pub brand: AccountInfo<'info>,

    #[account(
        seeds = [CONTRACT_RECORD_SEED, brand.key().as_ref(), &contract_id],
        bump = record.bump,
    )]
    pub record: Account<'info, ContractRecord>,

    /// CHECK: The rated counterparty. Must be either `record.brand` or
    /// `record.creator` (validated in handler).
    pub subject: AccountInfo<'info>,

    #[account(
        init,
        payer = reviewer,
        space = 8 + ReputationCard::INIT_SPACE,
        seeds = [REPUTATION_SEED, subject.key().as_ref(), &contract_id],
        bump,
    )]
    pub card: Account<'info, ReputationCard>,

    #[account(mut)]
    pub reviewer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<MintReputation>,
    _contract_id: [u8; 32],
    axes: [u8; 4],
    comment_hash: [u8; 32],
) -> Result<()> {
    let record = &ctx.accounts.record;
    let reviewer_key = ctx.accounts.reviewer.key();
    let subject_key = ctx.accounts.subject.key();

    // Reviewer must be a party to the contract.
    require!(
        reviewer_key == record.brand || reviewer_key == record.creator,
        EscrowError::NotAParty
    );

    // Subject must be the OTHER party (and not the reviewer).
    require!(reviewer_key != subject_key, EscrowError::SelfRating);
    require!(
        subject_key == record.brand || subject_key == record.creator,
        EscrowError::NotAParty
    );

    // Refund-resolved contracts produce no rating: no service was rendered to
    // the creator, no marketplace experience to score.
    let ratable = match record.outcome {
        SettledOutcome::Settled => true,
        SettledOutcome::Resolved(Outcome::Release) => true,
        SettledOutcome::Resolved(Outcome::Split { .. }) => true,
        SettledOutcome::Resolved(Outcome::Refund) => false,
    };
    require!(ratable, EscrowError::NotRatable);

    // Each axis must be in 1..=5.
    for &axis in axes.iter() {
        require!(axis >= 1 && axis <= 5, EscrowError::InvalidAxis);
    }

    let card = &mut ctx.accounts.card;
    card.record = record.key();
    card.reviewer = reviewer_key;
    card.subject = subject_key;
    card.axes = axes;
    card.comment_hash = comment_hash;
    card.amount_lamports = record.price_lamports;
    card.timestamp = Clock::get()?.unix_timestamp;
    card.bump = ctx.bumps.card;

    Ok(())
}
