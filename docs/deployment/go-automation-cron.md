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
- The flag covers the cron only. A write the Go API serves wakes an event tick, and
  `POST /system/automations/tick` runs one for an administrator, whatever the flag says. `GO_ROUTES` is empty, so
  neither happens today.

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
| Browser push | `FOR UPDATE OF d SKIP LOCKED`, sets the attempt and a 120 s lease in one statement | A delivery goes to one runner |
| Polling | `UPDATE … WHERE` due, on the feed and on the connector's settings | Each source is fetched by one runner |
| Narratives | Id derived from the feed URL and item key | The same item is never imported twice |
| Attempt record | `last_tick_token` | The cursor shows only the newest attempt of either API |

`TestBothAPIsRunningDeliverEachMessageOnce` runs two Go schedules and a third runner that claims with TypeScript's
statement, read from its source file, on one PostgreSQL database. Its scans, sends and finishes are Go's, and its
clock is frozen, so leases never expire. Removing the claim's row lock makes it fail with a message sent twice;
removing the cursor lock does not, because the unique run absorbs the repeat. `TestTwoRunnersPollEachSourceOnce`
proves the polling between Go runners; the statements TypeScript runs are the same.
`TestBothAPIsRunningSendEachPushOnce` does for browser pushes what the first test does for channels, with TypeScript's
claim read from `sql-push-store.ts`; removing the row lock makes it fail with pushes sent twice.

**Messages can still repeat, with one runner or two, in either API.** Slack, Teams, Discord, Telegram and browser
push services do not deduplicate, and a run left pending is sent again after its lease:

- **A hard kill** between the send and `FinishRun`.
- **A database failure** in `FinishRun` after a successful send.
- **A timed-out send the channel did accept**, which is retried as a failure.
- **Clock skew.** The settle window and the lease use each runner's clock. A runner about 110 s ahead (the lease
  minus the send timeout) can claim a run still being sent. Smaller skew narrows the settle window instead, so a
  commit later than 60 s minus the skew could be passed over and never queued. Hosts on NTP are far below both.

One case differs between the APIs. When settling an accepted push fails, TypeScript marks it pending, so it goes out
again. Go retries the `accepted` state once and leaves the row alone if that fails too, so the lease alone can repeat
it.

## Shutdown

On SIGTERM the schedule stops first, then the process drains for up to 20 s before closing the pool. This covers
schedule ticks and the ticks of the cron and tick routes:

1. No further tenant starts, and rescans are dropped; the next runner catches up.
2. Polling is cancelled. It sends nothing. A cancelled feed waits 30 minutes and the Defensoría connector 15 for
   their next turn. The attempt ends `failed` and logs `automation_tick_failed`, so one such line at a shutdown is
   expected.
3. The tick in flight keeps its context, because cutting it between the send and `FinishRun` would repeat the
   message. It needs at most 18 s: the 8 s execution budget plus one 10 s send.

A request slower than the 10 s server grace still makes the process exit with an error, after the drain.

## How the switch happens

Every step needs the owner's go-ahead. **The procedure cannot run on Cloudflare until the two decisions below are
made:** with `GO_ROUTES` empty no request reaches the container, so it never starts and the flag has no effect.

1. Apply decision 1, so that something starts the container and keeps it ticking.
2. Forward the flag, `SIPGES_DATA_KEY`, `SIPGES_DATA_KEY_PREVIOUS`, `SIPGES_CRON_SECRET` and `SIPGES_VAPID_*` in
   `goContainerEnv`
   (`apps/hosting-cloudflare/src/go-routes.ts`). None reaches the container today, so the flag cannot turn on there
   by accident.
3. Set `SIPGES_GO_AUTOMATION_CRON=1` on the `sipges-go` trial Worker, on a Neon branch.
4. Check `automation_schedule_started` in the logs, `last_tick_source = 'cron'` on the cursors, and no
   `automation_tick_failed` outside a shutdown.
5. Compare a day of `automation_runs` and `audit` with TypeScript: `attempts` stays 1, and each `CHANNEL_SEND`
   appears once per run.
6. Apply decision 2.

**To go back,** unset the flag and restart. Both APIs use the same tables, so there is nothing to migrate.

## Decisions for the owner

**1. What wakes Go in production.** The container starts only when a Go-routed request arrives and sleeps after 10
minutes without one (`GO_SLEEP_AFTER`). A timer inside a stopped container does not fire, so scheduled ticks would
stop with no error.

- **Keep the container running:** the timer works as built, but something must start it and it bills around the
  clock.
- **Have the Worker's Cron Trigger call Go's cron route:** the container can sleep, but the `scheduled` handler must
  change, because it runs TypeScript directly, and the route needs a path to Go. Only the production Worker has a
  trigger, so a trial needs one on `sipges-go`, and production needs the container bound. The `*/15` trigger is
  longer than the 10-minute sleep, so each call pays a cold start.

**2. What happens to the work only TypeScript does.** Go leaves `evaluate` steps unclaimed, because they need the
intelligence context's `createAlert`. Go delivers browser pushes when it has `SIPGES_VAPID_*`; without those keys
they wait for TypeScript. Removing the Cron Trigger does not stop TypeScript either: `eventAutomation: true` makes every write it serves
scan, claim and send. Those runs and `push_deliveries` would move only when the next TypeScript write wakes a tick,
and never once writes move to Go. Until both are ported, either TypeScript keeps ticking beside Go, which the table
above shows is safe, or those features stop.
