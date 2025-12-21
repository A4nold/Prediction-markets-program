# Copilot instructions — prediction_program

Purpose

- Help a coding agent understand and safely modify this Anchor-based Solana program and its TypeScript tests.

Quick architecture summary

- Rust Anchor program lives at `programs/prediction_program/src/lib.rs` (entrypoint uses `#[program]`).
- Program ID is declared with `declare_id!` and mirrored in `Anchor.toml` under `[programs.localnet]`.
- Tests and client glue are TypeScript under `tests/` and import generated IDL/types from `target/types/prediction_program`.
- Build artefacts and deployment keys appear in `target/deploy` (e.g. `prediction_program-keypair.json`).

Essential workflows (discoverable here)

- Package manager: `yarn` (see `Anchor.toml` -> `toolchain.package_manager`).
- Build the program and regenerate TypeScript types: run `anchor build` from the repo root.
- Run tests: either `anchor test` (Anchor will build + run tests against a local validator) or the explicit test command defined in `Anchor.toml`:
  - `yarn run ts-mocha -p ./tsconfig.json -t 1000000 "tests/**/*.ts"`
- Anchor uses `localnet` config (see `Anchor.toml -> [provider]cluster = "localnet"`). Ensure a local validator is available when running integration tests.

Project-specific conventions & patterns

- Anchor version: project uses `anchor-lang` / `@coral-xyz/anchor` (see `programs/*/Cargo.toml` and `package.json`).
- TypeScript tests use the new Anchor client call pattern: `program.methods.<ixName>(...).rpc()` (see `tests/prediction_program.ts`).
- Tests reference the generated IDL/types at `../target/types/prediction_program` — keep `anchor build` up to date after Rust changes.
- Migrations: `migrations/deploy.ts` exists but is a no-op placeholder. Anchor will pick up migration scripts if populated.

Key files to inspect when changing behavior

- Program logic: `programs/prediction_program/src/lib.rs`
- Program manifest/config: `programs/prediction_program/Cargo.toml`, `Anchor.toml`
- TypeScript tests: `tests/prediction_program.ts` (example of test harness and client usage)
- Deploy artifacts: `target/deploy/prediction_program-keypair.json`

Safe change checklist for agents

- After modifying Rust program code:
  - Run `anchor build` and ensure `target/types/prediction_program` updates.
  - Update or add TypeScript tests under `tests/` that exercise new/changed instructions.
  - Run `anchor test` (or the explicit `ts-mocha` command) to validate end-to-end behavior.
- Don’t change the program ID in `lib.rs` without also updating `Anchor.toml` and noting migration implications.

Notes & gotchas

- The project expects `yarn` as primary package manager (Anchor.toml `toolchain.package_manager`). Use `yarn` to install dependencies.
- The TypeScript test timeout is raised in the ts-mocha command (`-t 1000000`) to allow Anchor/localnet startup; keep this when running tests under slower environments.

If anything here is unclear or you'd like more details (deploy steps, CI hooks, or more test examples), tell me which area to expand.
