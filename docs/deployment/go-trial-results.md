# `sipges-go` trial results, Wave A

**Verdict: `basic` is not enough for Wave A at 8 simultaneous screens.** It served everything without one error and beat production on every screen, but the container ran at 100 % of its 1/4 vCPU, and in the three runs in Chicago 6 to 8 of the 9 Wave A routes the load script calls were slower than TypeScript on the same database. At 4 screens Go is about twice as fast or better. Do not switch production on this instance size; measure the next size up, or find what uses the CPU, first.

Measured 2026-11-06 on `sipges-go`, Wave A only, on the Neon branch `go-trial`, a full copy of production. Worker `ab9d2c1f` plus Wave A in `GO_ROUTES`, unmerged. Nothing was deployed to production.

## Against the targets

| Target | Result | Pass |
| --- | --- | --- |
| Errors: 0 | 0 in 71,535 requests to Go, 0 in the TypeScript and production runs | **Pass** |
| Memory below `GOMEMLIMIT=800MiB` | Peak 108 MiB, from per-minute samples with gaps | **Pass** |
| Cold start ≤ 3 s, five samples | 2,662–2,867 ms, all 200. A sixth, unplanned wake took 3,417 ms | **Pass, thin margin** |
| Screens no worse than baseline, production | Better on every screen at 4 and 8, all five runs. At 1, every p50 is better; one p95 is 18 ms worse, from a single sample | **Pass** |
| Screens no worse than baseline, routes off | Better at 4. At 1, every p50 is better, and p95 is worse in runs A1 and C1 from single slow samples. At 8, `Registros lista` p95 was worse in two of the three Chicago runs | **Fail, small** |
| No listed route slower with Go | Holds in the Atlanta runs. In the three Chicago runs at 8 screens, 6, 8 and 8 of 9 routes were slower against routes off | **Fail at 8 screens** |
| Query to Neon from the container, p50 ≤ 35 ms, p95 ≤ 45 ms | Not measured: there is no way to run a query inside the container | **Unknown** |
| B7: same answers on real rows | 560 of 560 equal in value | **Pass for Wave A** |
| B3: `basic` holds 8 screens | No errors, but no headroom | **Fail** |

## Why `basic` falls short

During the 8-screen run C1 `cpuUtilization` reached 1.07 (`cpuLoad` 0.268). Run A1 reached `cpuLoad` 0.227, which is 0.91 by the same ratio. The two fields kept a ratio of exactly 4 in every sample read, so utilization is `cpuLoad` over the 1/4 vCPU. Cloudflare's page does not define either field; that reading is inferred from the ratio.

Throughput then stops growing. In Chicago it stayed at 60–65 req/s from 8 to 16 screens, and only latency rose. It is not a hard limit: the same load gave no errors at 16 screens, with p95 up to 5.7 s.

What the container is spending that CPU on was not investigated. Small routes alone reached 39 req/s with `cpuUtilization` near 0.12, so the cost looks to be in the larger answers and `/system/irsa`.

Placement decides how bad it gets. `regions: ["ENAM"]` put the instance in Atlanta, then Chicago, then Atlanta. The routes that stay on TypeScript did not move between runs (mean p50 about 260 ms); Wave A did:

| Run | Place | Time UTC | Req/s at 8 screens | Wave A mean p50 |
| --- | --- | --- | --- | --- |
| A1 | Atlanta | 08:13 | 105 | 461 ms |
| A2 | Atlanta | 18:05 | 78 | 652 ms |
| C1 | Chicago | 17:46 | 60 | 864 ms |
| C2 | Chicago | 17:48 | 60 | 874 ms |
| C3 | Chicago | 17:49 | 60 | 852 ms |
| Off | Worker only | 17:02 | 54 | 799 ms |
| Prod | Worker only | 08:41 | 45 | 870 ms |

Two runs in Atlanta differ by 40 %, so the place explains part of this, not all of it.

## Load results

`bench:prod-screens` logic with its `SCREENS`, steps 1, 4 and 8, 20 s each, one `consulta` account, run from Lima. One change, in a private copy of the runner: it stops at 2 % errors instead of 20 %. Off means the same Worker and database with `SIPGES_GO_ROUTING` off. Production ran read-only at 08:41; the other runs came hours later, on a different database branch.

Whole screen, p50/p95 in ms:

| Screens | Run | Requests | Req/s | Inicio | Registros | Registros lista | IRSA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A1 | 170 | 9 | 482/3055 | 384/1832 | 478/2511 | 728/2524 |
| 1 | A2 | 310 | 16 | 395/693 | 341/576 | 446/600 | 663/784 |
| 1 | C1 | 257 | 13 | 488/3784 | 422/467 | 463/517 | 686/803 |
| 1 | C2 | 310 | 16 | 481/585 | 412/570 | 441/554 | 656/779 |
| 1 | C3 | 310 | 16 | 477/559 | 479/605 | 382/487 | 651/767 |
| 1 | Off | 133 | 7 | 1302/1534 | 1020/1121 | 1027/1226 | 1303/1442 |
| 1 | Prod | 77 | 4 | 1265/3925 | 986/2072 | 3247/3272 | 1319/2506 |
| 4 | A1 | 1519 | 76 | 317/434 | 305/481 | 324/521 | 637/731 |
| 4 | A2 | 1308 | 65 | 451/564 | 383/554 | 354/547 | 664/787 |
| 4 | C1 | 1023 | 51 | 695/809 | 499/715 | 515/697 | 687/992 |
| 4 | C2 | 1078 | 54 | 641/822 | 510/675 | 500/655 | 666/827 |
| 4 | C3 | 1069 | 53 | 676/796 | 501/633 | 493/643 | 673/791 |
| 4 | Off | 541 | 27 | 1309/1566 | 1016/1221 | 1021/1190 | 1306/1555 |
| 4 | Prod | 543 | 27 | 1266/1805 | 991/1312 | 999/1578 | 1325/1575 |
| 8 | A1 | 2090 | 105 | 701/882 | 521/782 | 459/658 | 670/818 |
| 8 | A2 | 1559 | 78 | 896/1093 | 724/895 | 744/943 | 876/1102 |
| 8 | C1 | 1204 | 60 | 1182/1326 | 926/1181 | 940/1171 | 1186/1472 |
| 8 | C2 | 1204 | 60 | 1187/1404 | 911/1174 | 1004/1284 | 1163/1394 |
| 8 | C3 | 1200 | 60 | 1092/1401 | 926/1221 | 974/1270 | 1216/1435 |
| 8 | Off | 1070 | 54 | 1311/1611 | 1013/1231 | 1022/1196 | 1325/1584 |
| 8 | Prod | 896 | 45 | 1431/1970 | 1131/1762 | 1308/1857 | 1507/2361 |
| 12 | Chicago | 1255 | 63 | 1603/1810 | 1401/1594 | 1484/1833 | 1614/2002 |
| 16 | Chicago | 1308 | 65 | 1895/2510 | 1730/3539 | 1825/2805 | 2023/5736 |

Every step above answered 100 % `200`. The 3 s p95 values at one screen come from a single slow sample: at that step a screen opens few times.

Per route at 8 screens, the Wave A routes the script calls, p50/p95 in ms. Bold is slower than Off:

| Route | A1 | C1 | Off | Prod |
| --- | --- | --- | --- | --- |
| `/system/notifications` | 408/660 | **793/990** | 662/873 | 790/1271 |
| `/system/v4/settings` | 415/657 | **793/998** | 666/867 | 724/1570 |
| `/api/dashboard` | 534/714 | 874/1092 | 908/1130 | 957/1969 |
| `/system/irsa` | 639/841 | 1180/1393 | 1318/1580 | 1430/2192 |
| `/api/registros/summary` | 485/767 | 920/1169 | 1017/1204 | 1050/1725 |
| `/api/fuentes` | 389/548 | **861/1161** | 670/888 | 770/1248 |
| `/system/uploads` | 382/520 | **861/1047** | 668/841 | 679/1215 |
| `/api/alertas` | 507/703 | **769/984** | 668/896 | 678/1098 |
| `/api/eventos` | 502/700 | **778/988** | 666/848 | 718/1360 |

### Each route alone

All 23 first-paint URLs, one at a time, 8 clients for 65 s. 54,361 requests to Go and 18,811 to TypeScript, all `200`. Go ran in Atlanta. Here every route is faster with Go.

Memory comes from `containersMetricsAdaptiveGroups`, the largest minute that overlaps the route's window. Cloudflare reports per minute, per instance, not per route, and two windows have no sample, so read it as an approximation and carry-over from the route before.

| URL | Go p50/p95 | Go req/s | TS p50/p95 | TS req/s | Peak MiB |
| --- | --- | --- | --- | --- | --- |
| `/system/notifications?limit=30` | 202/215 | 39.2 | 656/768 | 12.0 | 87 |
| `/system/v4/settings` | 201/216 | 39.4 | 663/763 | 11.8 | 69 |
| `/api/dashboard` | 218/233 | 36.2 | 898/998 | 9.0 | 73 |
| `/system/irsa` | 677/808 | 12.1 | 1292/1445 | 6.4 | 108 |
| `/system/model-status` | 154/163 | 51.4 | 157/231 | 48.7 | 108 |
| `/api/registros/summary?limit=500&offset=0` | 250/516 | 28.0 | 1007/1127 | 8.3 | 101 |
| `/system/uploads?linked_module=fuentes&limit=500` | 205/219 | 38.2 | 705/799 | 11.4 | 96 |
| `/api/eventos?…` | 202/214 | 39.4 | 661/734 | 12.0 | 102 |
| `/api/actores?…` | 340/522 | 21.9 | 979/1102 | 8.6 | 102 |
| `/api/directorio?…` | 200/211 | 39.8 | 667/761 | 11.8 | no sample |
| `/api/demandas?…` | 222/582 | 30.0 | 796/903 | 10.1 | no sample |
| `/api/compromisos?…` | 235/582 | 28.7 | 839/949 | 9.7 | 96 |
| `/api/narrativas?…` | 201/241 | 39.2 | 676/729 | 11.8 | 96 |
| `/api/fuentes?…` | 203/217 | 38.7 | 679/737 | 11.7 | 96 |
| `/api/alertas?…` | 202/216 | 39.2 | 669/762 | 11.8 | 95 |
| `/api/acciones?…` | 201/211 | 39.6 | 671/742 | 11.7 | 95 |
| `/api/intereses?…` | 202/210 | 39.5 | 675/771 | 11.7 | 95 |
| `/api/dialogos?…` | 202/241 | 39.0 | 673/786 | 11.7 | 95 |
| `/api/oportunidades?…` | 202/212 | 39.4 | 664/762 | 11.9 | 95 |
| `/api/hechos?…` | 201/211 | 39.6 | 671/761 | 11.8 | 95 |
| `/api/aarc?…` | 202/213 | 39.4 | 669/727 | 11.8 | 95 |
| `/api/buzon?…` | 201/211 | 39.6 | 674/724 | 11.8 | 95 |
| `/api/lecciones?…` | 203/240 | 38.7 | 674/774 | 11.7 | 95 |

`?…` is `?limit=500&offset=0&q=`. Nine of these lists are empty in the load account's project, so their figures are the cost of the session and an empty answer. Go's requests were bounded by latency here, not by the server.

### Cold start

First Go-routed request after more than 12 minutes idle, through the Worker, with a session, from Lima:

| Sample | First request | Next three |
| --- | --- | --- |
| 1 | 2,867 ms | 282, 270, 367 |
| 2 | 2,833 ms | 230, 227, 229 |
| 3 | 2,829 ms | 288, 289, 340 |
| 4 | 2,662 ms | 225, 221, 221 |
| 5 | 2,774 ms | 267, 265, 266 |

A later wake, with no session and at a new placement, took 3,417 ms. After a failed start the first good request took 7.8 s.

### Latency floor

Sequential, 38 samples each, Chicago, p50/p95: Go 401 with no session 158/171, `/system/model-status` 181/192, an empty list 246/259, `/api/dashboard` 267/275. So database work adds about 20–110 ms per request. This is an inference, not the S8 measurement.

## B7: TypeScript on the Worker against Go, on real rows

**560 of 560 responses equal in status, media type and JSON value**, with `apps/parity/src/diff.ts` and no normalized field. Go was captured before and after TypeScript; both captures are byte-identical to each other, so the rows did not move.

- 112 URLs: the 23 of the first paint, plus for each of the 16 modules a second page, a small page, two searches (one with an accent) and no query, plus variants of the summary, notifications and uploads.
- 5 identities: the `consulta` account in its project, with no project header, and in another project, where all 112 answer `403`; and `admin` in each of the two projects.
- 6.4 MB of bodies: 448 `200` and 112 `403`.
- 116 responses differ in bytes, by Go's one trailing newline. 4 of those also order keys differently. JSON readers see no difference.

This also settles, for Wave A, the advisory that parity ran TypeScript on Node and not on Workers. It covers only Wave A URLs and two projects. Bodies stayed in private scratch and were deleted; no value appears here.

## Checklist

| Check | Result |
| --- | --- |
| `/health/ready` | `200` |
| `/api/dashboard`, no session | `401 {"detail": "Inicie sesión para acceder a SIPGES"}` |
| `smoke-go.mjs` | `Listed route answered the sign-in 401`, exit 0. With the container dead, exit 1 |
| Session issued by TypeScript accepted by Go | Yes, with TOTP. The cookie is `HttpOnly; Secure; SameSite=Strict` |
| Session revoked in TypeScript | `401` from Go on the next request, by logout and by expiry set on the branch |
| Dead container | `503 {"detail": "SIPGES no está disponible temporalmente"}`, JSON, with `no-store`, HSTS and `nosniff`, in 4–5 s. `/health/ready` stayed `200` |
| Container config | `basic`, 1/4 vCPU, 1 GiB, `ENAM`, `sleepAfter` 10 m |
| `sipges_app` | No superuser, no `BYPASSRLS`, no `CREATEROLE`, no `CREATEDB`. Owns everything in `public` |

### How we know Go answered

**The container's own logs were not read.** The wrangler login has no Workers Observability scope, the API answers 403, and `wrangler tail` shows only the Worker. So there is no log line from Go, and no-BYPASSRLS rests on the role flags plus the fact that Go serves authenticated reads: the refusal stops it at start. The evidence that Go answered:

- TypeScript's answers carry `server-timing` and `traceresponse`; Go's do not. With routes on, 23 of 23 URLs have neither, and the control `/system/auth/me` has both. With routes off, all 23 have both.
- With `/api/lecciones` removed from the list, that URL alone changed side.
- `wrangler tail` shows an access log line for TypeScript requests and none for listed routes.
- With the container dead, listed routes answer 503 while TypeScript routes keep working.

## Rollback, timed

Time is from starting the command to the first answer from the other side, polling every 0.5 s with a session.

| Action | CLI | Effective |
| --- | --- | --- |
| Routing off: `wrangler deploy --var SIPGES_GO_ROUTING:0 --containers-rollout none` | 17.9 s | 17.0 s, no failed poll |
| Routing on: same deploy, no override | 14.5 s | 14.1 s |
| `wrangler rollback <version>`, healthy | 3.2 s | **4.0 s**, no failed poll |
| `wrangler rollback <version>`, during the outage | 3.7 s | TypeScript first at 9.6 s, stable at 30.9 s, mixed with 503 in between |
| Remove one route, deploy | 14.6 s | Seen on TypeScript 15 s later |

`--containers-rollout none` skips the image build, so a rollback needs no Docker and no local `data/` directory ends up in a build context.

## Found on the way

1. **Recovery from a failed start is slow.** After the database URL was fixed, Go kept answering 503 for 235.5 s (45 polls) before it came back. The cause is not established. A rollback to TypeScript took under 31 s, so roll back first and fix second.
2. **`wrangler rollback` blocks `wrangler secret put`.** It refuses until the latest version is deployed: `the latest version of your Worker isn't currently deployed`. The trial's first restore failed this way, silently under a filtered command. Deploy first, and read the result.
3. **The admin bootstrap does nothing on a copy.** `bootstrapAdmin` runs only on an empty installation, so `trial-admin` did not exist. It and `trial-load` were made on the branch: the first by SQL as `sipges_app`, the second through the Worker. Add this to step 2B of the runbook.
4. **A TOTP step works once.** A login in the same 30 s as `totp/enable` answers 401.
5. **The dead-container test used an invalid database URL**, not the owner's URL from the runbook: no owner URL was on hand. Go exits at the same point, before listening.

## Limits of this run

- Production writes: the baseline signed in, selected a project and signed out, so the load account's session and TOTP step changed there. No business row was written.
- Wave A only. Waves B and C were not measured, though the order of work asks for it, and Wave C adds three routes on every screen.
- One account, from Lima. Real use spreads differently, and how many people open screens at once in production was not measured.
- Billing was not compared.
- The next instance size was not tried.

## Next

1. Owner decides B7: on this evidence it is clear for Wave A.
2. Find what uses the CPU at 8 screens, then measure the next size up with the same script, in the same placement where possible.
3. Decide how many simultaneous screens production needs. At 4 or fewer, `basic` already passes everything measured.

The trial stays up until the branch expires, with Wave A on and the real database URL restored; `smoke-go.mjs` passes. Removal is step 9 of the [runbook](go-trial-runbook.md).
