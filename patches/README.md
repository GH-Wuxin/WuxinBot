# PP+ first-query fix

`ppplus-first-info.patch` contains the source changes and JUnit tests for the
locally installed `lazybot-ppplus` 0.1.15 aggregate. Deploy it together with the
Wuxin client in `server/osu/pplus.ts`; that client uses the new task endpoints.

Apply from an unpatched aggregate source directory:

```powershell
git apply --check --ignore-space-change 'G:\QQ-AI-ChatBot\patches\ppplus-first-info.patch'
git apply --ignore-space-change 'G:\QQ-AI-ChatBot\patches\ppplus-first-info.patch'
mvn '-Dmaven.compiler.enablePreview=true' '-DargLine=--enable-preview' package
```

Use JDK 21. The `me.zhjk:rosu-ppplus:0.2.2` dependency is not on Maven Central;
reuse `BOOT-INF/lib/rosu-ppplus-0.2.2.jar` from the existing installed aggregate,
and install that unchanged jar with Maven `install:install-file` under the same
coordinates. The current installation already has this dependency in its local
Maven repository. No calculator algorithm was changed.

The deployment order is aggregate first, then Wuxin. Back up the old jar and
the three Wuxin files (`server/osu/pplus.ts`, `server/bots/playerSkillProfile.ts`,
`server/index.ts`), stop only the aggregate, replace its jar, and start it. Copy
the Wuxin files and restart only Wuxin. Keep the database and other bots running.
Rollback must restore both the client and aggregate to their corresponding
backups. Validate the settings through the authenticated Wuxin settings API;
never put credentials in this repository or build commands.

## Contract

- `POST /player/jobs?id=<osuId>` creates or reuses one job per player. It returns
  promptly with `queued`, `running`, `completed`, or `failed` in `data.status`.
- `GET /player/jobs/status?id=<osuId>` only observes a job; it never initializes
  a player. A missing job has business code 404. Both endpoints require the
  existing bearer authentication.
- A completed job has `data.result.performances`; a failed job has an error code
  (`NO_SCORES`, `CALCULATION_FAILED`, or `QUEUE_FULL`). Internal errors stay in the
  service log. Two workers and a bounded queue limit expensive work.
- Legacy `/player/info` and `/player/update` remain supported. First-time
  initialization is shared with legacy requests through player locks; network
  downloads happen outside database transactions. The player marker and score
  rows are committed atomically after calculation.
- Download failures return their rate-limit permits after the usual delay.
  Responses are written to a temporary file before replacing a cached resource.
- Wuxin uses 15-second HTTP requests to poll up to 30 minutes, shares concurrent
  requests for a player, and persists valid six-dimensional results for 24 hours.
  It never substitutes an automatic recent-score refresh for initialization.
- Authentication and calculation errors propagate through `/w info` instead of
  generating an incomplete card and a successful command log. Missing scores
  receive a separate explanation. Changed configured credentials must validate
  before `/api/settings` persists them, including stale GUI submissions.

Run `npm run pplus:verify` for the Wuxin lifecycle/integration checks. The Maven
build runs the aggregate job-concurrency and failed-download-permit tests.
For a live cold test, select a player absent from `player_summary`; do not delete
production rows to manufacture a cold cache. Use isolated Wuxin test data and
render the normal profile pipeline without sending a QQ message.
