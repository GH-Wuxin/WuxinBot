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

Direct social V2 turns combine a small participation decision with the normal
persona reply. Ordinary members can still receive a `pass`; Owner rules remain
enforced. A valid plain answer is an implicit choice to reply, so it never waits
for a second social assessment after generation. Empty responses are failures,
not implicit passes. Internal JSON cannot be emitted as ordinary prose. Ambient
talk uses a separate participation-only decision where necessary. The core persona, configured model,
custom personality sections and permission boundaries are unchanged. Optional
tool inspection does not force a higher reasoning tier than plain conversation.
When self-inspection is the only tool surface, the conversation module's custom
personality supplement is preserved. Incomplete or unwrapped JSON is rejected
before delivery, including output that omitted the expected `social` field.

`settings.pippiFastReplies=false` or `PIPPI_FAST_REPLIES=0` selects the old separate
assessment path. There is no database migration or historical rewrite required
for this switch. Fixed inter-segment typing sleeps are removed. Tool deduplication
happens before parallel dispatch, including duplicates within one model response.
Unambiguously other-directed messages do not trigger a full sending-time model
review; ambiguous corrections still do. Existing foreground priority and background
concurrency limits remain in effect.

Relationship, mood and experience updates run after delivery or a deliberate pass.
`social/reflection.ts` keeps evidence/revision validation and serializes reflection
calls in the existing background lane. Pending work is saved in
`socialV2.reflectionQueue`; restart recovery and bounded retries reuse only the
original scoped message IDs. Deleted evidence cannot recreate memories. Failed
responses never mutate relationship data. There are at most 128 in-memory jobs;
additional work stays persisted for later admission. Three failed attempts stay
visible as exhausted jobs instead of retrying indefinitely. `/api/health` exposes
queue counts only. Rollback code tolerates the additive queue field.

Complex explicit @ requests can send short progress replies. An Owner request or
an already accepted participation decision can acknowledge after about 1.2 s;
ordinary members wait for actual tool dispatch or the model's public participation
object. A pass stays silent. Provider reasoning is never forwarded. At most two
progress messages are sent, with at least eight seconds between them. A subsequent
update requires an actual tool result. Cancellation/final delivery aborts optional
sends. Progress records use `originModule=notice`, so they do not consume reply
quotas or become ordinary conversation context. Set
`settings.pippiProgressReplies=false` or `PIPPI_PROGRESS_REPLIES=0` to disable this
feature. Existing thinking-notice settings remain available for other requests.

Detailed @ requests have an 8,192-token generation allowance and a 90-second call
deadline, allowing reasoning plus the requested text on compatibility endpoints.
Complete answers up to 1,800 characters use up to three paragraph-preserving
messages; larger/code-heavy answers retain merged-forward delivery. Text is still
validated before sending; this does not stream unvalidated partial answers.

The interaction follows OpenAI's [tool preamble guidance](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide#tool-preambles):
brief intent first and truthful progress during longer work, adapted to Pippi's
group-chat tone without adding a separate model call for every update.

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
