# Pippi Sticker System — Production Goal

This document is the compact, repository-local statement of the immutable goal.

WuxinBot must be able to let Pippi decide from the current conversation whether
an additional sticker has expressive value, which validated sticker to use, and
whether the result is text-only, text plus image, or image-only where that is
safe. The feature must remain an optional extension of the existing LLM,
queue, persistence, request-trace, and OneBot delivery paths.

Required properties:

- only accepted, existing assets can be selected;
- the LLM chooses semantic intent; code does not use keyword-to-sticker maps;
- invalid, missing, timed-out, or unsafe decisions degrade to normal text;
- group and user frequency budgets, duplicate suppression, and concurrency
  reservations are deterministic, configurable, and persisted;
- OneBot outcomes distinguish confirmed success, accepted/unknown,
  confirmed failure, and unknown; uncertain delivery is never blindly retried;
- dry-run never calls the real image delivery path;
- trace-once explains selection, gating, delivery, and failure without leaking
  secrets or full private chat content;
- ordinary replies, tools, osu! commands, and existing image delivery remain
  equivalent when stickers are disabled;
- production starts closed, supports a narrowly-scoped test-group rollout, and
  has an immediate independent rollback switch;
- automated, simulated, and authorized real-group evidence are kept separate.

The current target group used for authorized smoke tests is `1083681153`.
The current user-authorized real gray-observation groups are `1067117635`
(`light`) and `682910196` (`natural`). `682910196` uses the natural reply
gate threshold `30` for this rollout. These scopes are separate from the
smoke group and neither is a production default.

