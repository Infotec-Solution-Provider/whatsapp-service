# WABA reaction receipt ledger

`waba_reaction_operations` correlates an outbound reaction with its own provider
message ID and asynchronous receipts. It never creates or changes ordinary
messages or queue rows. The ledger is needed because `message_reactions` retains
only the latest reaction for an actor and therefore loses superseded receipt IDs.

The sender commits `prepare` before its HTTP call and sends the returned
`callbackData` when supported. It then runs `accept` in an owned transaction.
`applyStatus` also requires an owned transaction and the verified instance,
client/account/phone scope. A receipt without callback data can match the real
provider ID recorded by `accept`; a receipt with callback data can arrive first.
Timeouts use `unknown`, definitive HTTP rejections use `reject`. A failed or
rejected acceptance is not a successful send. No extra pool or Prisma engine is
created by this store.

`accept` and `applyStatus` lock the original message row and materialize the self
reaction in the same transaction. All material reads after that lock use current
locking reads, including on MySQL's default REPEATABLE READ isolation. Hydration
and socket notifications run only after commit. The caller must not perform a
second `MessageReactionsRepository.apply` after WABA acceptance.

Durable preparation sequence determines the newest eligible operation, regardless
of HTTP completion order. FAILED and REJECTED operations cannot be restored by a
later receipt. A failed replacement falls back to the latest eligible predecessor
or the external baseline captured before this ledger. Both orders of predecessor
failures and newer removals are handled by rederiving this state. Synthetic
tombstones and restored baseline sources retain their original lineage; correction
timestamps remain monotonic for frontend snapshots. Duplicate receipts rerun
materialization, and a transaction failure rolls back both receipt and reaction.

The migration is additive and idempotent, with its matching Prisma model kept in
`schema.prisma`. `WABA_REACTION_SCHEMA_SQL` and
`assertWabaReactionOperationsSchema` verify the table engine, columns, defaults,
collations, indexes and checks. Apply only this reviewed migration through the
environment's approved procedure; do not run all pending Prisma migrations.

Isolated SQL QA entrypoint:

```text
node scripts/test-waba-reaction-receipts-mysql.cjs <adapter.cjs> <compiled-dist> homolog-reaction-qa-YYYYMMDD prisma/migrations/20261112190000_waba_reaction_operations/migration.sql
```

The injected adapter provides `$queryRawUnsafe`, `$executeRawUnsafe`, transaction
callbacks and `close`. The suite refuses every database name except the scratch
prefix, creates minimal fake fixture tables and uses a second connection for the
REPEATABLE READ regression. It does not read app credentials or contact WhatsApp.
