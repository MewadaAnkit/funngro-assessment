# Funngro — Backend Engineering Assessment
**Candidate Submission: Node.js / MongoDB Payout & Reward Systems**

---

## Directory Structure

```
├── README.md                     # Root assessment overview and navigation
├── part1-code-review/
│   ├── ANSWERS.md                # 8 ranked bugs, scale architecture & Round 2 Extension
│   └── withdraw.js               # Production-ready payout handler rewrite (with INR 2,000 IST daily limit)
├── part2-schema-design/
│   ├── ANSWERS.md                # Reward points schemas, index rationale & double-conversion defense
│   └── rewards.js                # Aggregation pipeline for monthly finance reporting
├── part3-incident-response/
│   └── ANSWERS.md                # 30-minute 9:00 PM payout outage incident playbook
└── part4-recording/
    └── ANSWERS.md                # 5-minute video walkthrough talk-track and question for founders
```

---

## Quick Navigation

| Assessment Section | Topic | File Link |
| :--- | :--- | :--- |
| **Part 1.1** | Bug severity ranking, realistic scenarios, and fixes | [part1-code-review/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part1-code-review/ANSWERS.md#1-blind-trust-of-reqbodyuserid-critical-security-issue) |
| **Part 1.2** | Production payout handler implementation | [part1-code-review/withdraw.js](file:///c:/Users/HP/Desktop/funngro-assessment/part1-code-review/withdraw.js) |
| **Part 1.3** | Architectural redesign for payouts at scale | [part1-code-review/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part1-code-review/ANSWERS.md#architectural-changes-for-scale-35-sentences) |
| **Round 2 Live Extension** | **Daily Limit (INR 2,000 IST) & Real-time Balance Notification Architecture** | [part1-code-review/ANSWERS.md (Round 2)](file:///c:/Users/HP/Desktop/funngro-assessment/part1-code-review/ANSWERS.md#round-2-extension-daily-limit-inr-2000-ist--real-time-balance-notifications) |
| **Part 2.1** | Reward points collections & index rationale | [part2-schema-design/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part2-schema-design/ANSWERS.md#1-collections--field-types) |
| **Part 2.2** | Monthly finance aggregation pipeline | [part2-schema-design/rewards.js](file:///c:/Users/HP/Desktop/funngro-assessment/part2-schema-design/rewards.js) |
| **Part 2.3** | Preventing concurrent double-conversion | [part2-schema-design/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part2-schema-design/ANSWERS.md#3-how-we-prevent-double-conversion-under-concurrent-requests) |
| **Part 3** | Step-by-step 30-minute 9:00 PM incident response playbook | [part3-incident-response/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part3-incident-response/ANSWERS.md) |
| **Part 4** | Screen recording script (top bugs + gateway idempotency questions) | [part4-recording/ANSWERS.md](file:///c:/Users/HP/Desktop/funngro-assessment/part4-recording/ANSWERS.md) |

---

## Summary of Core Principles Applied

- **Security & Financial Safety First:** Account takeover (blind trust of `userId`), retry duplicate payouts, and race conditions are prioritized ahead of general code hygiene.
- **Airtight Money Path:** Atomic `$gte` conditional decrements inside MongoDB multi-document transactions, lease-backed idempotency locks, deterministic gateway deduplication references, and safe reconciliation states (no blind auto-refunds).
- **Round 2 Concurrency Defense:** Atomic per-user daily withdrawal limits (INR 2,000 IST calendar day) tracked via `UserDailyLimits` with atomic `$lte` increment guards inside the session transaction.
- **Decoupled Event Architecture:** Real-time wallet balance notifications implemented via **MongoDB Change Streams (CDC)** and message queues (BullMQ), isolating financial ACID transactions from third-party notification latency and downtime.
- **Index & Query Reasoning:** Eliminating the catastrophic 40M unindexed `Ledger` COLLSCAN, with index definitions explicitly mapped to production query shapes and properly scoped per-user idempotency keys.
- **Incident Playbook:** Clear distinction between containment ("stop the bleeding first") and safe reconciliation via small state-machine collections (`WithdrawalIntents`) rather than querying unindexed production tables.
- **Record Script:** Tailored 5-minute concise, colleague-to-colleague walkthrough with incisive technical questions for the founders.
