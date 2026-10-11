# Pippi Sticker System — Rollback

## Runtime rollback (required first action)

Turn the global sticker switch off. The expected result is that ordinary text,
tool calls, osu! commands, queues, and existing image outputs continue while no
new model-selected sticker is reserved or sent.

Persistent source control:

```json
{ "mode": "off", "allGroups": false, "groupIds": [] }
```

Set it through the protected local `POST /api/sticker-policy` route. For an
emergency process-level override, use:

```text
WUXIN_STICKER_DELIVERY_MODE=off
```

The environment override takes precedence over the saved policy. Do not rely
on deleting assets to disable the feature.

## Gray-scope rollback

Set `allGroups` back to `false` and remove the test group from the allowlist,
or disable the global switch. A group outside the allowlist must never receive
model-selected stickers unless the explicit all-group switch is enabled.

## Code rollback

Before release, record the release commit SHA and preserve the prior build.
Rollback the sticker-specific commit(s) only if runtime disable cannot restore
normal operation. Do not reset or clean a dirty worktree containing unrelated
user changes.

## Unknown delivery

If OneBot reports `accepted_unknown` or `unknown`, do not resend the same
sticker automatically. Keep the reservation consumed until the configured
deduplication window expires or an operator explicitly diagnoses it.

## Post-rollback checks

1. Verify the effective global mode is off.
2. Send/observe one ordinary text reply without a sticker.
3. Confirm no new sticker delivery attempts in request traces and counters.
4. Confirm normal OneBot health and text delivery remain healthy.
5. Record the reason, time, build SHA, and any uncertain deliveries.

