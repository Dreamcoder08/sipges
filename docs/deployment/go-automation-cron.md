# Moving the automation cron to Go

How the Go API takes over the automation cron, what happens if both APIs run it, and what still needs the
owner. Nothing here changes production: the flag is off by default, so TypeScript stays the only runner.

## What the flag does

`SIPGES_GO_AUTOMATION_CRON` is the only switch. It accepts unset, `0` or `1`.

| | Unset or `0` (default) | `1` |
| --- | --- | --- |
| Schedule | Not started | Every `SIPGES_AUTOMATION_INTERVAL` seconds, 5 to 3600, default 30 |
| Feed and Defensoría polling | Not wired | Runs before each cron tick, per tenant |
| `/system/automations/cron` | 401 for every caller, even with `SIPGES_CRON_SECRET` | Accepts the secret |
| `SIPGES_DATA_KEY` | Optional | Required: the API refuses to start without it |

- `SIPGES_AUTOMATION_INTERVAL` alone never starts anything, because the Go API reads it only after the flag.
  An environment shared with TypeScript cannot start a second runner.
- With the flag on, an interval of `0` or out of range stops the start. A cron that was asked for and does
  not run would fail silently.
- Event ticks are separate: a write the Go API serves wakes a tick whatever the flag says. `GO_ROUTES` is
  empty, so none does today.

## If both run

Two runners are safe by design, not by coordination. This is what happens at each step when TypeScript and
Go, or two Go instances, tick the same tenant:

| Step | Guard | Result |
| --- | --- | --- |
| Scan | `SELECT … FROM automation_cursors FOR UPDATE` | Scans of a tenant run one at a time |
| Queue | Unique run per rule, event and step, `ON CONFLICT DO NOTHING` | An event scanned twice is queued once |
| Settle window | The cursor passes an event only when it is 60 s old | Late commits are read again, and the unique run absorbs the repeat |
| Claim | `FOR UPDATE … SKIP LOCKED`, sets the attempt and a 120 s lease in one statement | A run goes to one runner; the other takes the next |
| Send | The lease outlasts the 10 s send timeout | No live send is claimed again |
| Polling | `UPDATE … WHERE` due, on the feed and on the connector's settings | Each source is fetched by one runner |
| Narratives | Id derived from the feed URL and item key | The same item is never imported twice |
| Attempt record | `last_tick_token` | The cursor shows only the newest attempt of either API |

`TestBothAPIsRunningDeliverEachMessageOnce` proves this against PostgreSQL with two Go schedules and a third
runner that claims with TypeScript's statement, read from its source file. Removing the row lock from the claim
makes that test fail with a message sent twice. `TestTwoRunnersPollEachSourceOnce` proves the polling.

**Two limits remain:**

- **A hard kill between the send and `FinishRun` repeats that message** once the lease expires. Both APIs do
  this, with one runner or two; Slack, Teams, Discord and Telegram do not deduplicate.
- **Clocks.** The settle window and the lease use each runner's clock. Skew between the APIs narrows the window
  by that amount, so a commit later than 60 s minus the skew could be passed over. It cannot cause a duplicate
  scan, and it needs skew in the tens of seconds; hosts on NTP are far below that. A runner whose clock is more
  than 120 s ahead would see leases as expired and could repeat a send.

## Shutdown

On SIGTERM the schedule stops first, then the process drains for up to 20 s before closing the pool:

1. No further tenant starts, and rescans are dropped; the next runner catches up.
2. Polling is cancelled. It sends nothing, and a cancelled feed waits for its next 30-minute turn.
3. The tick in flight keeps its context, because cutting it between the send and `FinishRun` would repeat the
   message. It needs at most 18 s: the 8 s execution budget plus one 10 s send.

## How the switch happens

Every step needs the owner's go-ahead, and the two decisions below come first.

1. Forward the flag, `SIPGES_DATA_KEY` and `SIPGES_CRON_SECRET` in `goContainerEnv`
   (`apps/hosting-cloudflare/src/go-routes.ts`). None reaches the container today, so the flag cannot turn on there
   by accident.
2. Set `SIPGES_GO_AUTOMATION_CRON=1` on the `sipges-go` trial Worker, on a Neon branch.
3. Check `automation_schedule_started` in the logs, `last_tick_source = 'cron'` on the cursors, and no
   `automation_tick_failed`.
4. Compare a day of `automation_runs` and `audit` with TypeScript: `attempts` stays 1, and each `CHANNEL_SEND`
   appears once per run.
5. Only after decision 2: stop the TypeScript tick by removing the Cron Trigger from `wrangler.jsonc`.

**To go back,** unset the flag and restart. Both APIs use the same tables, so there is nothing to migrate.

## Decisions for the owner

**1. What wakes Go in production.** The container sleeps after 10 minutes without Go-routed requests
(`GO_SLEEP_AFTER`), and a timer inside a stopped container does not fire. Scheduled ticks would stop with no error.
Keeping the container awake bills it around the clock; having a Cron Trigger call `/system/automations/cron` on Go
keeps the sleep, but it adds that route to `GO_ROUTES`, and the Worker's trigger stays.

**2. What happens to the work only TypeScript does.** Go leaves `evaluate` steps unclaimed, because they need the
intelligence context's `createAlert`, and only TypeScript delivers browser pushes, because that needs the VAPID
keys. If the TypeScript tick stops, those runs and `push_deliveries` wait forever. Until both are ported, either the
TypeScript tick keeps running beside Go, which the table above shows is safe, or those features stop.
