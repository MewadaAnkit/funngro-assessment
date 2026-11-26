// part1-code-review/withdraw.js
// POST /api/wallet/withdraw
// Assumptions:
// 1. Auth middleware has authenticated the request and populated `req.user.id`.
// 2. All monetary values are strictly positive integers in minor units (paise).
//    e.g., INR 100.00 = 10000 paise.
// 3. Database collections: Users, Wallets, Ledger, WithdrawalIntents, UserDailyLimits.
//
// Required Database Indexes (Created via migrations or startup script):
// - Wallets:           { userId: 1 } [UNIQUE]
// - WithdrawalIntents: { userId: 1, idempotencyKey: 1 } [UNIQUE]
// - WithdrawalIntents: { status: 1, updatedAt: 1 }
// - UserDailyLimits:   { userId: 1, date: 1 } [UNIQUE]
// - Ledger:            { _id: 1 } [DEFAULT UNIQUE], { userId: 1, createdAt: -1 }

const { ObjectId } = require('mongodb');

const DAILY_WITHDRAWAL_LIMIT_PAISE = 2_000 * 100; // INR 2,000 per calendar day in IST (200,000 paise)
const PROCESSING_LOCK_TIMEOUT_MS = 60 * 1000; // 60-second lease to prevent stuck "processing" locks

class InsufficientFundsError extends Error {}
class DailyLimitExceededError extends Error {}
class LeaseExpiredError extends Error {}

/**
 * Calculates the current calendar date string (YYYY-MM-DD) in Indian Standard Time (IST, UTC+05:30).
 * Ensures daily withdrawal limits strictly reset at 00:00:00 IST.
 */
function getISTCalendarDate(date = new Date()) {
  const IST_OFFSET_MS = 330 * 60 * 1000; // 5 hours 30 mins
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  const yyyy = istDate.getUTCFullYear();
  const mm = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(istDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`; // e.g. "2026-11-26"
}

/**
 * Production-ready payout withdrawal handler.
 * - Enforces authentication and input boundaries (minor currency units).
 * - Enforces per-user daily withdrawal limit of INR 2,000 (IST calendar day) under high concurrency.
 * - Implements strict idempotency with a fenced lease-backed state machine.
 * - Uses atomic balance decrement with MongoDB ACID transaction.
 * - Isolates third-party gateway network calls outside DB transaction locks.
 * - Separates gateway network errors from post-payout database persistence errors.
 * - Safely handles timeouts via reconciliation states without blind auto-refunds.
 * - Eliminates unindexed table scans on the 40M-record Ledger collection.
 */
async function withdraw(req, res) {
  // 1. Security: Never trust identity from request body for money movement
  const userId = req.user?.id;
  const { amount, idempotencyKey } = req.body;

  if (!userId) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // 2. Strict input validation (paise integers, positive, below daily ceiling)
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 128) {
    return res.status(400).json({ error: 'valid idempotencyKey is required (max 128 chars)' });
  }

  if (!Number.isInteger(amount) || amount <= 0 || amount > DAILY_WITHDRAWAL_LIMIT_PAISE) {
    return res.status(400).json({
      error: `invalid withdrawal amount; must be a positive integer in paise up to daily limit of INR 2,000 (${DAILY_WITHDRAWAL_LIMIT_PAISE} paise)`
    });
  }

  // 3. Pre-flight verification: Check user and bank details BEFORE touching any money
  const user = await Users.findOne({ _id: userId }, { bankAccount: 1, kycStatus: 1 });
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }
  if (!user.bankAccount) {
    return res.status(400).json({ error: 'bank account details missing; please link bank account first' });
  }

  // 4. Idempotency Registration: Deduplicate client retries per user
  let intent;
  try {
    intent = await WithdrawalIntents.findOneAndUpdate(
      { userId, idempotencyKey },
      {
        $setOnInsert: {
          userId,
          idempotencyKey,
          amount,
          status: 'created',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );
  } catch (err) {
    // Handle race condition on compound unique index (userId + idempotencyKey)
    if (err.code === 11000) {
      intent = await WithdrawalIntents.findOne({ userId, idempotencyKey });
    } else {
      throw err;
    }
  }

  // Payload integrity check: Reject if same idempotency key is reused with a different amount
  if (intent.amount !== amount) {
    return res.status(422).json({ error: 'idempotencyKey already used with a different amount' });
  }

  // Fast-path: Return cached terminal status
  if (intent.status === 'completed') {
    return res.json(toClientResponse(intent));
  }
  if (intent.status === 'rejected_insufficient_funds') {
    return res.status(400).json({ error: 'insufficient balance' });
  }
  if (intent.status === 'rejected_daily_limit_exceeded') {
    return res.status(400).json({ error: 'daily withdrawal limit of INR 2,000 exceeded for today (calendar day in IST)' });
  }

  // Note on 'debited' or 'pending_reconciliation' status on retry:
  // If the server crashed after debiting the wallet but before the gateway response arrived,
  // returning 202 Accepted informs the client that funds are reserved. The background
  // reconciliation worker is guaranteed to pick up stale 'debited' intents and poll or dispatch
  // to the gateway to reach a terminal state.
  if (intent.status === 'debited' || intent.status === 'pending_reconciliation') {
    return res.status(202).json(toClientResponse(intent));
  }

  // 5. Atomic Claim with Fenced Lease Token:
  // Transitions 'created' -> 'processing'. Also allows re-claiming if a previous attempt
  // crashed in 'processing' longer than PROCESSING_LOCK_TIMEOUT_MS ago.
  // Generates a unique leaseId acting as a fencing token against zombie processes.
  const leaseId = new ObjectId();
  const lockExpiration = new Date(Date.now() - PROCESSING_LOCK_TIMEOUT_MS);
  const claimed = await WithdrawalIntents.findOneAndUpdate(
    {
      _id: intent._id,
      $or: [
        { status: 'created' },
        { status: 'processing', updatedAt: { $lt: lockExpiration } }
      ]
    },
    { $set: { status: 'processing', leaseId: leaseId, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );

  if (!claimed) {
    const active = await WithdrawalIntents.findOne({ _id: intent._id });
    if (active.status === 'processing') {
      return res.status(409).json({ error: 'withdrawal request is currently in progress; please retry shortly' });
    }
    if (active.status === 'rejected_insufficient_funds') {
      return res.status(400).json({ error: 'insufficient balance' });
    }
    if (active.status === 'rejected_daily_limit_exceeded') {
      return res.status(400).json({ error: 'daily withdrawal limit of INR 2,000 exceeded for today (calendar day in IST)' });
    }
    return res.json(toClientResponse(active));
  }

  // 6. Atomic Daily Limit Check, Debit & Ledger Entry inside a MongoDB ACID transaction
  const session = client.startSession();
  let walletAfter;
  let ledgerId;

  try {
    await session.withTransaction(async () => {
      // 6.1 Move date calculation INSIDE transaction callback so midnight retries re-evaluate exact date
      const istDateStr = getISTCalendarDate();

      // 6.2 Validate that our lease is still valid (fencing token check)
      const currentIntent = await WithdrawalIntents.findOne(
        { _id: claimed._id, leaseId: leaseId, status: 'processing' },
        { session }
      );
      if (!currentIntent) {
        throw new LeaseExpiredError('Processing lease expired or stolen by concurrent worker');
      }

      // 6.3 Enforce per-user daily withdrawal limit of INR 2,000 (calendar day in IST)
      // Concurrency protection: MongoDB document-level concurrency control & write-conflict handling
      // serialize concurrent writes to the same daily limit document.

      // Ensure daily tracking document exists for this user and IST date
      await UserDailyLimits.updateOne(
        { userId, date: istDateStr },
        {
          $setOnInsert: {
            userId,
            date: istDateStr,
            withdrawnPaise: 0,
            createdAt: new Date()
          }
        },
        { upsert: true, session }
      );

      // Atomically verify that withdrawnPaise + amount <= DAILY_WITHDRAWAL_LIMIT_PAISE and increment
      const dailyUsageDoc = await UserDailyLimits.findOneAndUpdate(
        {
          userId,
          date: istDateStr,
          withdrawnPaise: { $lte: DAILY_WITHDRAWAL_LIMIT_PAISE - amount }
        },
        {
          $inc: { withdrawnPaise: amount },
          $set: { updatedAt: new Date() }
        },
        { returnDocument: 'after', session }
      );

      if (!dailyUsageDoc) {
        throw new DailyLimitExceededError('daily withdrawal limit of INR 2,000 exceeded for today (calendar day in IST)');
      }

      // 6.4 Atomic conditional update on wallet balance (ensures balance cannot go negative)
      walletAfter = await Wallets.findOneAndUpdate(
        { userId, balance: { $gte: amount } },
        { $inc: { balance: -amount }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', session }
      );

      if (!walletAfter) {
        throw new InsufficientFundsError('insufficient balance');
      }

      // 6.5 Record immutable ledger entry in the same transaction
      const ledgerResult = await Ledger.insertOne(
        {
          userId,
          withdrawalIntentId: claimed._id,
          type: 'withdrawal',
          amount,
          balanceAfter: walletAfter.balance,
          status: 'pending_gateway',
          createdAt: new Date()
        },
        { session }
      );
      ledgerId = ledgerResult.insertedId;

      // Persist dailyLimitDate, ledgerId, and bankAccount snapshot so worker has complete state
      await WithdrawalIntents.updateOne(
        { _id: claimed._id, leaseId: leaseId },
        {
          $set: {
            status: 'debited',
            dailyLimitDate: istDateStr,
            ledgerId: ledgerId,
            bankAccount: user.bankAccount,
            updatedAt: new Date()
          }
        },
        { session }
      );
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // Persist failure outside the aborted transaction so status is not rolled back
      await WithdrawalIntents.updateOne(
        { _id: claimed._id },
        { $set: { status: 'rejected_insufficient_funds', updatedAt: new Date() } }
      );
      return res.status(400).json({ error: 'insufficient balance' });
    }

    if (err instanceof DailyLimitExceededError) {
      // Persist limit rejection outside transaction so retry doesn't hang in processing
      await WithdrawalIntents.updateOne(
        { _id: claimed._id },
        { $set: { status: 'rejected_daily_limit_exceeded', updatedAt: new Date() } }
      );
      return res.status(400).json({ error: 'daily withdrawal limit of INR 2,000 exceeded for today (calendar day in IST)' });
    }

    if (err instanceof LeaseExpiredError) {
      return res.status(409).json({ error: 'lease expired during processing; please retry' });
    }

    // Reset lock to 'created' on unexpected transient DB failure so client can retry immediately
    await WithdrawalIntents.updateOne(
      { _id: claimed._id, leaseId: leaseId, status: 'processing' },
      { $set: { status: 'created', updatedAt: new Date(), lastError: String(err.message || err) } }
    ).catch(() => {});

    throw err;
  } finally {
    await session.endSession();
  }

  // 7. Dispatch Gateway Payout (OUTSIDE DB transaction to prevent holding DB locks)
  let payoutResult;
  try {
    payoutResult = await gateway.createPayout({
      account: user.bankAccount,
      amount: amount,
      reference: `WD-${claimed._id}` // Deterministic ref enables gateway-side deduplication
    });
  } catch (gatewayError) {
    // Gateway timeout, network drop, or unknown error:
    // CRITICAL: Do NOT auto-refund here — money may have already been dispatched.
    // Flag for background reconciliation worker.
    await Ledger.updateOne(
      { _id: ledgerId },
      {
        $set: {
          status: 'gateway_error_pending_reconciliation',
          gatewayError: String(gatewayError.message || gatewayError),
          updatedAt: new Date()
        }
      }
    ).catch(() => {});

    await WithdrawalIntents.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: 'pending_reconciliation',
          gatewayError: String(gatewayError.message || gatewayError),
          updatedAt: new Date()
        }
      }
    ).catch(() => {});

    logger.error('Gateway payout call failed; queued for reconciliation', {
      withdrawalId: claimed._id,
      error: gatewayError
    });

    return res.status(202).json({
      ok: true,
      balance: walletAfter.balance,
      withdrawalId: claimed._id,
      status: 'pending_reconciliation',
      message: 'Your withdrawal is being processed and will be confirmed shortly.'
    });
  }

  // 8. Gateway Succeeded: Persist completion in DB
  // Separated from gateway try/catch so DB persistence glitches are not misclassified as gateway errors
  try {
    // Update Ledger via primary key _id to avoid unindexed scans on 40M rows
    await Ledger.updateOne(
      { _id: ledgerId },
      { $set: { status: 'completed', gatewayRef: payoutResult.id, updatedAt: new Date() } }
    );

    await WithdrawalIntents.updateOne(
      { _id: claimed._id },
      { $set: { status: 'completed', gatewayRef: payoutResult.id, updatedAt: new Date() } }
    );
  } catch (dbError) {
    logger.error('Gateway payout succeeded but database status update failed', {
      withdrawalId: claimed._id,
      gatewayRef: payoutResult.id,
      error: dbError
    });
    // Even if local DB write had a transient glitch, the money transfer was confirmed.
    // Return success to the client with the confirmed reference.
  }

  return res.json({
    ok: true,
    balance: walletAfter.balance,
    withdrawalId: claimed._id,
    status: 'completed'
  });
}

function toClientResponse(intentRecord) {
  return {
    ok: intentRecord.status !== 'rejected_insufficient_funds' && intentRecord.status !== 'rejected_daily_limit_exceeded',
    withdrawalId: intentRecord._id,
    status: intentRecord.status
  };
}

module.exports = { withdraw };

// ============================================================================
// BACKGROUND RECONCILIATION WORKER PSEUDOCODE (Runs out-of-band e.g. BullMQ)
// ============================================================================
// const RECONCILIATION_LEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5-minute lease to reclaim crashed jobs
//
// async function reconcilePendingPayouts() {
//   // Query strictly from WithdrawalIntents (small, indexed collection), NEVER unindexed Ledger
//   const cutoff = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes old
//   const staleReconciliationCutoff = new Date(Date.now() - RECONCILIATION_LEASE_TIMEOUT_MS);
//
//   // Candidates include un-reconciled intents AND stale reconciling intents where previous worker crashed
//   const candidates = await WithdrawalIntents.find({
//     $or: [
//       { status: { $in: ['pending_reconciliation', 'debited'] }, updatedAt: { $lt: cutoff } },
//       { status: 'reconciling', updatedAt: { $lt: staleReconciliationCutoff } }
//     ]
//   }).limit(50);
//
//   for (const intent of candidates) {
//     // Atomic worker lease claim so two concurrent worker instances don't process the same job
//     const workerLeaseId = new ObjectId();
//     const claimedJob = await WithdrawalIntents.findOneAndUpdate(
//       {
//         _id: intent._id,
//         $or: [
//           { status: { $in: ['pending_reconciliation', 'debited'] } },
//           { status: 'reconciling', updatedAt: { $lt: staleReconciliationCutoff } }
//         ]
//       },
//       { $set: { status: 'reconciling', workerLeaseId, updatedAt: new Date() } },
//       { returnDocument: 'after' }
//     );
//     if (!claimedJob) continue;
//
//     const gatewayStatus = await gateway.getPayoutStatus({ reference: `WD-${intent._id}` });
//
//     if (gatewayStatus.state === 'SUCCESS') {
//       // Update Ledger via primary key _id (using intent.ledgerId) to avoid 40M unindexed scans
//       if (intent.ledgerId) {
//         await Ledger.updateOne({ _id: intent.ledgerId }, { $set: { status: 'completed', gatewayRef: gatewayStatus.id, updatedAt: new Date() } });
//       }
//       await WithdrawalIntents.updateOne({ _id: intent._id, workerLeaseId }, { $set: { status: 'completed', gatewayRef: gatewayStatus.id, updatedAt: new Date() } });
//     } else if (gatewayStatus.state === 'FAILED') {
//       // Safely reverse wallet debit with strict state guard against duplicate or completed refunds
//       const session = client.startSession();
//       await session.withTransaction(async () => {
//         const updatedIntent = await WithdrawalIntents.findOneAndUpdate(
//           { _id: intent._id, workerLeaseId, status: { $in: ['reconciling', 'debited', 'pending_reconciliation'] } },
//           { $set: { status: 'refunded', updatedAt: new Date() } },
//           { session }
//         );
//         if (!updatedIntent) return; // Prevent refunding if already refunded or completed
//
//         const walletResult = await Wallets.updateOne(
//           { userId: intent.userId },
//           { $inc: { balance: intent.amount } },
//           { session }
//         );
//         if (walletResult.matchedCount !== 1) {
//           throw new Error('Wallet document not found during refund');
//         }
//
//         // Release daily limit strictly against the date on which the reservation was made
//         if (intent.dailyLimitDate) {
//           const limitResult = await UserDailyLimits.updateOne(
//             { userId: intent.userId, date: intent.dailyLimitDate, withdrawnPaise: { $gte: intent.amount } },
//             { $inc: { withdrawnPaise: -intent.amount }, $set: { updatedAt: new Date() } },
//             { session }
//           );
//           if (limitResult.modifiedCount !== 1) {
//             throw new Error('Daily limit reservation not found during refund release');
//           }
//         }
//
//         await Ledger.insertOne({
//           userId: intent.userId,
//           withdrawalIntentId: intent._id,
//           type: 'payout_refund',
//           amount: intent.amount,
//           createdAt: new Date()
//         }, { session });
//       });
//       await session.endSession();
//     } else if (gatewayStatus.state === 'NOT_FOUND' && intent.status === 'reconciling') {
//       // Server crashed after debit but BEFORE gateway.createPayout was ever dispatched:
//       // Securely retrieve bank details if not present on intent
//       let bankAccount = intent.bankAccount;
//       if (!bankAccount) {
//         const user = await Users.findOne({ _id: intent.userId }, { bankAccount: 1 });
//         bankAccount = user?.bankAccount;
//       }
//       if (!bankAccount) return; // Cannot dispatch without destination bank account
//
//       try {
//         const payoutResult = await gateway.createPayout({
//           account: bankAccount,
//           amount: intent.amount,
//           reference: `WD-${intent._id}`
//         });
//         await WithdrawalIntents.updateOne({ _id: intent._id, workerLeaseId }, { $set: { status: 'completed', gatewayRef: payoutResult.id, updatedAt: new Date() } });
//         if (intent.ledgerId) {
//           await Ledger.updateOne({ _id: intent.ledgerId }, { $set: { status: 'completed', gatewayRef: payoutResult.id, updatedAt: new Date() } });
//         }
//       } catch (dispatchErr) {
//         // Reset to pending_reconciliation for next poll
//         await WithdrawalIntents.updateOne({ _id: intent._id, workerLeaseId }, { $set: { status: 'pending_reconciliation', updatedAt: new Date() } });
//       }
//     }
//   }
// }
