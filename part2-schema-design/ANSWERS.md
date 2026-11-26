# Part 2 — Reward Points Schema and Query Design

Here is the design for the reward points system, keeping it simple, auditable, and fast to query.

---

## 1. Collections & Field Types

### Collection: `UserPointsBalance`
Stores the user's current point balance so we can check and deduct points instantly.
```javascript
{
  _id: ObjectId,
  userId: ObjectId,                // Reference to Users
  cohort: String,                  // User cohort, e.g. "2024-Q1-TEENS"
  availablePoints: Int,            // Current points balance (>= 0)
  lifetimeEarned: Int,             // Total points ever earned
  lifetimeConverted: Int,          // Total points converted to cash
  lifetimeExpired: Int,            // Total points expired
  updatedAt: Date
}
```

### Collection: `RewardPointsLedger`
The immutable passbook. Every single point that comes in or goes out is permanently written here.
```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  cohort: String,                  // Denormalized at time of event for fast reports
  type: String,                    // 'EARNED_PROJECT' | 'EARNED_PROMO' | 'CONVERTED' | 'EXPIRED'
  points: Int,                     // Amount of points (always positive integer)
  balanceAfter: Int,               // Snapshot of balance right after this event
  conversionRate: {                // Only present if type === 'CONVERTED'
    rateId: ObjectId,
    pointsPerRupee: Number,        // e.g. 100 points = INR 1.00
    cashCreditedPaise: Int         // e.g. 500 paise (INR 5.00)
  },
  sourceRef: {                     // Traceability
    entityType: String,            // 'project' | 'campaign' | 'wallet_tx'
    entityId: ObjectId
  },
  idempotencyKey: String,          // Client key scoped per user
  createdAt: Date
}
```

### Collection: `PointConversionRates`
Keeps track of point conversion rates over time so conversions are 100% auditable.
```javascript
{
  _id: ObjectId,
  pointsPerRupee: Number,          // e.g. 100 points = INR 1
  minPointsThreshold: Int,         // Min points needed to convert
  effectiveFrom: Date,
  effectiveTo: Date,               // null if currently active
  createdAt: Date
}
```

---

## Indexes & Query Rationale

* **`UserPointsBalance`: `{ userId: 1 }` (Unique)**
  * *Query served:* O(1) balance check and atomic row lock during point conversion (`findOneAndUpdate`).
* **`UserPointsBalance`: `{ cohort: 1 }`**
  * *Query served:* Filtering and grouping users by cohort.
* **`RewardPointsLedger`: `{ createdAt: 1, type: 1, cohort: 1 }`**
  * *Query served:* **Monthly finance aggregation report**. The index prefix matches the target month range (`createdAt`), and filters by `type` and `cohort` before grouping.
* **`RewardPointsLedger`: `{ userId: 1, createdAt: -1 }`**
  * *Query served:* In-app point history statement for the user.
* **`RewardPointsLedger`: `{ userId: 1, idempotencyKey: 1 }` (Unique, Sparse)**
  * *Query served:* Prevents duplicate credits/conversions if a user retries, scoped per user so User A and User B never conflict.
* **`RewardPointsLedger`: `{ "sourceRef.entityType": 1, "sourceRef.entityId": 1 }` (Sparse)**
  * *Query served:* Ensures a completed project or promo is never rewarded twice.
* **`PointConversionRates`: `{ effectiveFrom: -1, effectiveTo: 1 }`**
  * *Query served:* Fast lookup for the currently active conversion rate.

---

## 2. Aggregation Pipeline: Monthly Finance Report

This pipeline gives Finance the monthly breakdown per user: points earned, converted, and expired.

```javascript
db.RewardPointsLedger.aggregate([
  // 1. Pick records strictly in the target month using the index
  {
    $match: {
      createdAt: {
        $gte: ISODate("2024-04-01T00:00:00.000Z"),
        $lt: ISODate("2024-05-01T00:00:00.000Z")
      }
    }
  },
  // 2. Group by user and cohort, adding up points by type
  {
    $group: {
      _id: {
        userId: "$userId",
        cohort: "$cohort"
      },
      pointsEarned: {
        $sum: {
          $cond: [
            { $in: ["$type", ["EARNED_PROJECT", "EARNED_PROMO"]] },
            "$points",
            0
          ]
        }
      },
      pointsConverted: {
        $sum: {
          $cond: [
            { $eq: ["$type", "CONVERTED"] },
            "$points",
            0
          ]
        }
      },
      pointsExpired: {
        $sum: {
          $cond: [
            { $eq: ["$type", "EXPIRED"] },
            "$points",
            0
          ]
        }
      },
      totalEvents: { $sum: 1 }
    }
  },
  // 3. Format the final output shape for the finance team
  {
    $project: {
      _id: 0,
      userId: "$_id.userId",
      cohort: "$_id.cohort",
      pointsEarned: 1,
      pointsConverted: 1,
      pointsExpired: 1,
      netPointChange: {
        $subtract: [
          "$pointsEarned",
          { $add: ["$pointsConverted", "$pointsExpired"] }
        ]
      },
      totalEvents: 1
    }
  },
  {
    $sort: { cohort: 1, pointsConverted: -1 }
  }
]);
```

---

## 3. How We Prevent Double-Conversion Under Concurrent Requests

To stop a user from converting the same points balance twice, we use an atomic update on `UserPointsBalance` inside a MongoDB transaction:
```javascript
UserPointsBalance.findOneAndUpdate(
  { userId, availablePoints: { $gte: pointsToConvert } },
  { $inc: { availablePoints: -pointsToConvert } },
  { session }
);
```
MongoDB places an exclusive write lock on that user's document for the duration of the write. This means if two conversion requests land at the same millisecond, MongoDB runs them one after the other. The first request finds `availablePoints >= pointsToConvert`, deducts the points, writes a `CONVERTED` row to `RewardPointsLedger`, and credits the wallet. When the second request runs right after, the balance has already dropped, the `$gte` condition fails, the query returns `null`, and the transaction cleanly aborts with an "insufficient points" error. The user cannot convert the same points twice.
