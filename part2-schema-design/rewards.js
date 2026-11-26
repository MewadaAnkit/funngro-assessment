// part2-schema-design/rewards.js
/**
 * PART 2 - Schema and Query Design for Reward Points
 */

// ============================================================================
// 1. COLLECTION SCHEMAS & FIELD TYPES
// ============================================================================

/*
1. Collection: UserPointsBalance
   Tracks current point balance and user metadata for fast O(1) checks and atomic operations.
   Document Schema:
   {
     _id: ObjectId,
     userId: ObjectId,                // Reference to Users collection
     cohort: String,                  // User cohort tag e.g. "2024-Q1-TEENS", "COLLEGE-AMBASSADORS"
     availablePoints: Number (Int32), // Current balance eligible for conversion (>= 0)
     lifetimeEarned: Number (Int32),  // Cumulative earned points
     lifetimeConverted: Number (Int32),// Cumulative converted points
     lifetimeExpired: Number (Int32), // Cumulative expired points
     updatedAt: Date
   }

2. Collection: RewardPointsLedger
   Append-only, immutable financial audit ledger of every point delta.
   Document Schema:
   {
     _id: ObjectId,
     userId: ObjectId,
     cohort: String,                  // Denormalized at time of event for fast cohort reporting
     type: String,                    // Enum: "EARNED_PROJECT" | "EARNED_PROMO" | "CONVERTED" | "EXPIRED"
     points: Number (Int32),          // Magnitude of points (strictly positive integer)
     balanceAfter: Number (Int32),    // Snapshot of available balance after this event
     conversionRate: {                // Populated only when type === "CONVERTED"
       rateId: ObjectId,
       pointsPerRupee: Number,
       cashCreditedPaise: Number (Int64)
     },
     sourceRef: {                     // Audit traceability
       entityType: String,            // "project" | "campaign" | "wallet_tx"
       entityId: ObjectId
     },
     idempotencyKey: String,          // Client or event key, scoped per user
     createdAt: Date                  // Timestamp of event
   }

3. Collection: PointConversionRates
   Historical registry of dynamic point-to-cash conversion rates.
   Document Schema:
   {
     _id: ObjectId,
     pointsPerRupee: Number,          // e.g. 100 points = 1 Rupee (100 paise)
     minPointsThreshold: Number,      // Minimum points required to trigger conversion
     effectiveFrom: Date,
     effectiveTo: Date,               // null if currently active
     createdAt: Date
   }
*/

// ============================================================================
// INDEXES AND QUERY RATIONALE
// ============================================================================
/*
Collection: UserPointsBalance
- Index: { userId: 1 } (UNIQUE)
  Why: Guarantees one balance record per user. Enables instant O(1) lookups and
       exclusive atomic row locks during conversion (`findOneAndUpdate`).
- Index: { cohort: 1 }
  Why: Serves cohort filtering and cohort-level user segmentation analytics.

Collection: RewardPointsLedger
- Index: { createdAt: 1, type: 1, cohort: 1 }
  Why: Serves the monthly finance aggregation report. Enables index prefix scan on the
       requested date range (`createdAt`), followed by in-index filtering on `type` and `cohort`.
       (Aggregation grouping occurs over the filtered subset in memory/disk).
- Index: { userId: 1, createdAt: -1 }
  Why: Serves the in-app user reward history timeline and audit pagination.
- Index: { userId: 1, idempotencyKey: 1 } (UNIQUE, SPARSE)
  Why: Correctly scopes idempotency per user, preventing collisions across distinct users
       who happen to submit the same client key.
- Index: { "sourceRef.entityType": 1, "sourceRef.entityId": 1 } (SPARSE)
  Why: Guarantees operation-level uniqueness (e.g. points for a completed project cannot be granted twice).

Collection: PointConversionRates
- Index: { effectiveFrom: -1, effectiveTo: 1 }
  Why: Allows fast lookup of the active conversion rate (`effectiveFrom <= now && (effectiveTo == null || effectiveTo > now)`).
*/

// ============================================================================
// 2. AGGREGATION PIPELINE: MONTHLY FINANCE REPORT
// Report: Per user, points earned, converted, and expired in a given month.
// ============================================================================

function getMonthlyFinanceReportPipeline(startDate, endDate) {
  return [
    // Step 1: Filter ledger events strictly within the target month window using index prefix
    {
      $match: {
        createdAt: {
          $gte: startDate, // e.g. new Date('2024-04-01T00:00:00.000Z')
          $lt: endDate     // e.g. new Date('2024-05-01T00:00:00.000Z')
        }
      }
    },
    // Step 2: Group by user and cohort, conditionally summing points by type
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
        totalTransactions: { $sum: 1 }
      }
    },
    // Step 3: Reshape output for clear finance tabular consumption
    {
      $project: {
        _id: 0,
        userId: "$_id.userId",
        cohort: "$_id.cohort",
        pointsEarned: 1,
        pointsConverted: 1,
        pointsExpired: 1,
        netPointChange: {
          $subtract: ["$pointsEarned", { $add: ["$pointsConverted", "$pointsExpired"] }]
        },
        totalTransactions: 1
      }
    },
    // Step 4: Sort deterministically for reporting
    {
      $sort: {
        cohort: 1,
        pointsConverted: -1
      }
    }
  ];
}

module.exports = {
  getMonthlyFinanceReportPipeline
};
