# Pippi runtime awareness and direct replies

Outbound QQ messages are recorded by `server/onebot.ts` through
`server/messageFacts.ts`. The record starts as pending, keeps the actual platform
receipt, and becomes visible to conversation context only after confirmed success.
Unknown/failed sends are never represented as confirmed replies. Own-account
events reconcile receipts without re-entering chat; an event arriving before the
HTTP response is deduplicated when that response arrives. Each actual segment has
its own QQ message ID. Semantic quick-query summaries enrich the same record
without replacing the content that was sent.

Quotes are resolved within the account and group/private scope. A local UUID is
not a QQ message ID. Network quote lookups must prove the conversation scope;
missing or mismatched scope stays unknown. Private context excludes records
belonging to another private peer. Random images and thinking notices do not
consume the text reply quota or replace the last conversational reply target.
The existing random selection counters still mean selections, not confirmed sends;
the message journal is the delivery evidence. Legacy rows are not assigned invented
receipt IDs or silently promoted to confirmed success.

`inspect_capabilities` projects the live command and osu! tool catalogs plus public
features registered by loaded modules. New commands/tools use their existing
registration metadata. Automatic modules declare their public contract once,
beside the implementation:

```ts
registerPublicFeature({
  id: 'my_feature',
  description: 'User-facing description',
  trigger: 'automatic',
  visibility: 'public',
  state: (db, event) => featureEnabledFor(db, event) ? 'automatic' : 'disabled',
});
```

The query view is rebuilt from current permissions and switches; its version
changes with the public view. State callbacks are restricted to a closed enum,
including at runtime. No raw settings, implementation references, private paths,
connection credentials, or other-room state are returned. Owner-only command
documentation is available only in that Owner's private conversation. Capability
knowledge never authorizes execution. Automatic random images belong to Pippi's
own account; automatic triggering must not be described as a different sender.

`inspect_message` reads only the current conversation. It returns text/ownership,
delivery outcome and image count, without media URLs or filesystem paths. By
default it does not wait for image/query semantics. `include_summary=true` can
wait up to five seconds for that specific pending quick observation, then returns
an explicit pending/ready state. Ordinary conversation no longer drains every
pending summary for up to thirty seconds.

Direct social V2 turns combine the existing social assessment contract with the
normal persona reply in one model completion. Relationship deltas still pass the
same evidence/revision validation; ordinary members can still receive a `pass`,
and Owner rules remain enforced. Ambient participation keeps the existing
assessment flow. Malformed combined envelopes use the old assessment fallback
and cannot be emitted as raw internal JSON. The core persona, configured model,
custom personality sections and permission boundaries are unchanged. Optional
tool inspection does not force a higher reasoning tier than plain conversation.

`settings.pippiFastReplies=false` or `PIPPI_FAST_REPLIES=0` selects the old separate
assessment path. There is no database migration or historical rewrite required
for this switch. Fixed inter-segment typing sleeps are removed. Tool deduplication
happens before parallel dispatch, including duplicates within one model response.
Unambiguously other-directed messages do not trigger a full sending-time model
review; ambiguous corrections still do. Existing foreground priority and background
concurrency limits remain in effect.

Validation commands:

```text
npm run pippi:awareness:verify
npm run social:v2:verify
npm run sticker:bot:failure:verify
npm run tool:phases:verify
npm run check
```

The legacy social suite explicitly selects the rollback path; the new fast-path
suite exercises single-call generation, `pass`, relationship updates, tool lookup,
persona preservation, malformed output and private-context isolation. Message
tests include restart persistence, receipt races, account/group isolation, and
random-image quota independence. Existing production-isolation tests must be
rerun with the live writer stopped when they report INCONCLUSIVE; this is not a pass.
