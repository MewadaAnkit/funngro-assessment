# Part 3 — Production Incident Playbook (9:00 PM Payout Day)

**Context:** It is 9:00 PM on Payout Day. Latency has spiked from 300ms to 11s over the last hour. Customer Support is getting flooded with "money debited but not received" complaints. We did not write this system.

Here is my step-by-step game plan for the first 30 minutes.

---

## Minutes 0–5: Stop the bleeding first (Containment)

Before trying to figure out the root cause, I have to stop the bleeding so user balances are protected and the database doesn't crash completely.

1. **Pause new withdrawals:** Turn on a feature flag or maintenance mode for `POST /api/wallet/withdraw` to return a `503`: *"Withdrawals are temporarily paused for routine maintenance and will resume shortly."* If there is no feature flag, add a rate limit rule at Cloudflare/Nginx to throttle requests to 1 req/sec per user to stop the mobile retry storm.
2. **Kill blocking queries in MongoDB:** Open the Mongo Shell and run:
   ```javascript
   db.currentOp({ "active": true, "secs_running": { "$gt": 5 } })
   ```
   Look for slow queries scanning the 40M `Ledger` table. Grab their `opid` and kill them to free up database connections:
   ```javascript
   db.killOp(<opid>)
   ```

---

## Minutes 5–15: Check the three sources (Atlas, Gateway, Logs)

Now that incoming traffic is paused and the database has room to breathe, I check the triad:

### 1. MongoDB Atlas Metrics
* **What I look at:** CPU usage, Disk IOPS, and WiredTiger concurrent read/write tickets.
* **Trigger:** If CPU is stuck at 100% and tickets are at 0, open the **Query Profiler**. Look for `COLLSCAN` on the `Ledger` collection sorting by `createdAt`. This confirms unindexed table scans on 40M records.

### 2. Payment Gateway Dashboard
* **What I look at:** Success vs. Failure vs. Timeout graphs for the last 60 minutes, and average response time.
* **Trigger:**
  * If the gateway shows lots of **Timeouts (504)**: Downstream banking rail is slow or down.
  * If the gateway shows **429 Too Many Requests**: Our retry storm overwhelmed our gateway rate limit.
  * If the gateway shows normal green latency: The delay is 100% inside our own backend/DB.

### 3. Application Logs
* **What I look at:** Grep logs for retry spikes and gateway exceptions:
  ```bash
  grep "POST /api/wallet/withdraw" app.log | tail -n 500
  grep -E "gateway error|ETIMEDOUT|ECONNRESET" app.log | tail -n 100
  ```
* **Trigger:** If I see multiple requests from the same `userId` within 10 seconds, the mobile app is retrying due to timeouts, creating new references with `Date.now()`.

---

## Minutes 15–22: Fix the root cause & recover

* **If Atlas shows 100% CPU due to 40M Ledger queries:**
  1. Push an emergency hotfix PR that removes `Ledger.find({ userId }).sort({ createdAt: -1 })` from the withdrawal endpoint response.
  2. Start building the missing index in Atlas in the background:
     ```javascript
     db.Ledger.createIndex({ userId: 1, createdAt: -1 }, { background: true })
     ```
* **If the Gateway was timing out with `Date.now()` references:**
  Deploy our rewritten handler with deterministic references (`WD-${intent._id}`) and idempotency so retries cannot trigger duplicate bank transfers.

---

## Minutes 22–30: Reconcile affected users & communicate

### 1. Identify affected users safely (Golden Rule: Don't scan 40M Ledger!)
Do NOT run `db.Ledger.find(...)` across 40M rows during an outage. Instead, query the small **`WithdrawalIntents`** collection for today's unresolved payouts:
```javascript
const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // last 2 hours
const stuckIntents = db.WithdrawalIntents.find({
  status: { $in: ["debited", "pending_reconciliation", "processing"] },
  createdAt: { $gte: cutoff }
}).toArray();
```

### 2. Reconcile with Gateway Status
For every stuck intent:
* Call `gateway.getPayoutStatus({ reference: "WD-" + intent._id })`.
* **If Gateway says FAILED:** Safely refund the money to the user's wallet inside a transaction and write an audit row of type `payout_refund`.
* **If Gateway says SUCCESS:** Update the intent to `completed` and update the Ledger entry by its primary key `_id`.
* **If Gateway says INFLIGHT/UNKNOWN:** Leave it in `pending_reconciliation`. Do NOT refund yet.

### 3. Update Support & Leadership
Send a clear, measured update:
> *"We paused new withdrawals to stop the retry storm and protect user balances. Root cause was high database query latency on unindexed ledger reads. We have isolated all in-flight transactions from the last 2 hours and are reconciling each payout directly against payment gateway settlement logs before issuing refunds or completions. Regular updates will follow every 15 minutes."*

---

## What I would do before knowing the root cause
* **Pause withdrawals or throttle traffic:** Stopping traffic immediately stops the retry storm, prevents duplicate payouts, and gives the database room to recover.
* **Kill runaway queries (`db.killOp`):** Frees up exhausted database connection pools right away.

## What I would NOT do, and why
1. **I would NOT blindly restart the servers or database:** In-flight transactions talking to the bank gateway will get cut in half. When servers boot back up, thousands of queued mobile requests will hit at once ("thundering herd") and crash it again.
2. **I would NOT trigger bulk automatic refunds to wallets:** If a bank call timed out, the bank might still have transferred the money. Refunding the wallet before verifying gateway status causes a direct double payout (user gets bank money + wallet refund).
3. **I would NOT run unindexed queries on the 40M Ledger table:** Running ad-hoc scans on 40M rows during high load will saturate disk I/O and extend the outage. Always query from small intent tables or read replicas.
