# Privacy Requests (Data Access and Deletion)

Maintainer runbook for player data requests. Public contact: **support@shapestrikers.com** (Cloudflare Email Routing forwards it to the maintainer's private mailbox).

Never ask for, accept, or store passwords, verification codes, tokens, or screenshots of them. Never discuss request details in public GitHub issues.

## Self-service (in game)

Signed-in players, including guests, use **Account / Recovery → Your data**:

- **Download my history (JSON)** exports every cloud Run History record for the signed-in account. Being signed in proves ownership.
- **Delete my run history** (after a confirmation checkbox) calls `delete_my_run_history()`. It deletes the account's cloud history, advances a server-side deletion generation, and clears this browser's earlier pending/cached copies for the account and current guest flow. Runs started during deletion and pending runs from other devices using an older or unknown generation are held locally for explicit restore or discard; they are not automatically uploaded. Deletion cannot be started during a run.

Self-service deletion does not remove the sign-in identity, email, or leaderboard scores.

## Full account deletion (by email)

1. The player emails support@shapestrikers.com from the address linked to the account.
2. In Supabase **Authentication → Users**, find the user with that exact email. If none exists, reply that no linked account was found. Guest-only accounts have no email and cannot be verified; ask the player to link an email in game first.
3. Verify ownership: reply **to the account's email address** (not a different reply-to address) asking the player to confirm the deletion. A reply from that mailbox confirms control. Do not request codes or passwords.
4. After confirmation, copy the user's UUID and run in the Supabase **SQL Editor** (production requires the reviewed privacy migration):

   ```sql
   SELECT public.admin_erase_account('<user-uuid>');
   ```

   This deletes the player's leaderboard rows, multiplayer telemetry, queue rows and rooms where those optional tables exist, and the Auth user. A project without `mp_queue` or `mp_rooms` does not need unused tables created for deletion; `rooms` is zero when that table is absent. Other errors still abort the call rather than reporting success. Deleting the Auth user cascades to Run History, the erasure marker, sessions, and identities. The function is not callable through the public API.

   If the project denies deleting `auth.users` from SQL, the helper's whole call rolls back. The Dashboard fallback is not atomic: first prevent new activity for the account, then in one SQL transaction delete its leaderboard and telemetry rows, its queue row if `mp_queue` exists, and rooms where it is either player if `mp_rooms` exists. Verify room-state rows cascade as expected. Delete the same verified user from **Authentication → Users**, then verify Auth, history, erasure markers, sessions, identities, and all applicable related rows are gone. If activity cannot be prevented, a step fails, or cleanup cannot be verified, do not report completion; resolve it with a privileged operator.
5. Confirm `accountDeleted` is `true`, reply to the player that the deletion is complete, and delete the request email thread.

Browser-local data (unlocks, settings, cosmetics, pending history queue) lives only on the player's devices. Tell the player to clear site data for Shape Strikers on each device; the server rejects any pending upload for a deleted account.

## Access requests beyond the in-game export

If a player cannot use the in-game export, verify ownership as above, then export their rows from `public.run_history` and `public.leaderboard` by `owner_id`/`player_id` in the SQL Editor and reply with the file to the account's email address only.

## Staging verification

For an existing privacy installation with the earlier helper, apply [supabase_run_history_v1_privacy_repair.sql](../supabase_run_history_v1_privacy_repair.sql) rather than rerunning the run-once migration. New installations use the corrected [privacy migration](../supabase_run_history_v1_privacy.sql). Production changes require separate approval.

Run [tests/history/accountErasure.sql](../tests/history/accountErasure.sql) only on isolated staging with no concurrent activity. It temporarily renames the optional tables within a rolled-back transaction, checks all four present/absent combinations, account isolation, API-role restrictions, and rollback on a real deletion failure. The table names, fixture users/records, and test trigger are rolled back; on any error, issue `ROLLBACK;` before further work. Never use this schema-shape test on production.

The scoped repair and all four optional-table combinations passed on staging, including privilege restrictions, account isolation, and rollback after an intentional deletion error. The installed helper body was checked against the repository repair.

The privileged helper was exercised with two disposable anonymous accounts on isolated staging. Checks passed for Auth/session and history removal, erasure-marker cleanup, leaderboard/telemetry/queue cleanup, room deletion from either player position, and room-state cascades. The separate control account and its unrelated records remained usable until test cleanup. Auth and history uploads rejected the deleted account. Both fixtures and their test records were then removed.

This verifies the deletion mechanism, not the manual email ownership-confirmation exchange. Production still requires reviewed schema/configuration and separate authorization.

## Response time

Acknowledge requests promptly and complete verified requests within 30 days.
