import type { ThrottlerStorage } from '@nestjs/throttler';
import { MANAGED_RATE_LIMIT_MAX, managedRateLimit } from './managed.mode';

export const MANAGED_REQUEST_WINDOW_MS = 3_600_000;
// The whole reservation, every unit included. Redis that never answers
// (the real client queues commands while disconnected) admits nothing.
export const MANAGED_REQUEST_RESERVATION_TIMEOUT_MS = 5_000;
// The storage reports remaining seconds rounded up, and the block lasts at
// most one window (blockDuration is the window), so no backoff is longer.
const MAX_RETRY_AFTER_MS = MANAGED_REQUEST_WINDOW_MS + 1_000;

// Must also be used by the HTTP guard. A provider sub-request cannot receive
// a separate budget merely because it originates in a background dispatcher.
export function managedRequestBudgetKey(organizationId: string, name = 'default') {
  return `managed_org_${name}_${organizationId}`;
}

export type ManagedRequestBudgetCode =
  | 'RESERVED' | 'INVALID_REQUEST' | 'BUDGET_EXHAUSTED' | 'BUDGET_UNAVAILABLE';

// No key, organization or storage detail. retryAfterMs is set only for
// BUDGET_EXHAUSTED: at least one second, never beyond MAX_RETRY_AFTER_MS, and
// long enough to outlast the storage's block. null is never an instruction to
// retry now; the dispatcher applies its own persisted backoff.
export interface ManagedRequestReservation {
  accepted: boolean;
  code: ManagedRequestBudgetCode;
  retryAfterMs: number | null;
}

export interface ManagedRequestBudget {
  reserve(organizationId: string, units: number): Promise<boolean>;
  reserveDetailed(organizationId: string, units: number): Promise<ManagedRequestReservation>;
}

const reservation = (code: ManagedRequestBudgetCode, retryAfterMs: number | null = null) =>
  Object.freeze({ accepted: code === 'RESERVED', code, retryAfterMs });

// Storage seconds to milliseconds. A block without a readable positive expiry
// gets the longest one, never a short poll: every refused call still counts.
const retryAfterMs = (seconds: unknown) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, Math.ceil(seconds * 1_000)))
    : MAX_RETRY_AFTER_MS;

const EXPIRED = Symbol('expired');

export class SharedManagedRequestBudget implements ManagedRequestBudget {
  constructor(
    private readonly storage: Pick<ThrottlerStorage, 'increment'>,
    private readonly limit: () => number = managedRateLimit,
    private readonly timeoutMs: number = MANAGED_REQUEST_RESERVATION_TIMEOUT_MS
  ) {}

  async reserve(organizationId: string, units: number): Promise<boolean> {
    return (await this.reserveDetailed(organizationId, units)).accepted;
  }

  async reserveDetailed(organizationId: string, units: number): Promise<ManagedRequestReservation> {
    if (typeof organizationId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(organizationId)) {
      return reservation('INVALID_REQUEST');
    }
    let limit: number;
    try { limit = this.limit(); } catch { return reservation('BUDGET_UNAVAILABLE'); }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MANAGED_RATE_LIMIT_MAX ||
        !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 ||
        this.timeoutMs > MANAGED_REQUEST_RESERVATION_TIMEOUT_MS) return reservation('BUDGET_UNAVAILABLE');
    if (!Number.isSafeInteger(units) || units < 1 || units > limit) return reservation('INVALID_REQUEST');
    // The installed throttler increments one request at a time. Concurrent
    // reservations may consume some units and then fail; those units, and a
    // unit Redis counts after the deadline, are deliberately not refunded.
    // Only a fully reserved step may be admitted.
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof EXPIRED>((resolve) => {
      timer = setTimeout(() => { expired = true; resolve(EXPIRED); }, this.timeoutMs);
    });
    try {
      for (let unit = 0; unit < units; unit++) {
        if (expired) return reservation('BUDGET_UNAVAILABLE');
        // A late answer or rejection settles this race unobserved.
        const result = await Promise.race([
          (async () => this.storage.increment(
            managedRequestBudgetKey(organizationId), MANAGED_REQUEST_WINDOW_MS,
            limit, MANAGED_REQUEST_WINDOW_MS, 'default'
          ))(),
          deadline,
        ]);
        if (result === EXPIRED || !result || typeof result !== 'object' ||
            !Number.isSafeInteger(result.totalHits) || result.totalHits < 1 ||
            typeof result.isBlocked !== 'boolean') return reservation('BUDGET_UNAVAILABLE');
        if (result.isBlocked) {
          // After the block, hits counted during it in a still running window
          // would block again at once; then the window has to pass too.
          return reservation('BUDGET_EXHAUSTED', Math.max(
            retryAfterMs(result.timeToBlockExpire),
            result.totalHits >= limit ? retryAfterMs(result.timeToExpire) : 0
          ));
        }
        // Over the limit without a block is not the installed storage.
        if (result.totalHits > limit) return reservation('BUDGET_UNAVAILABLE');
      }
      return reservation('RESERVED');
    } catch {
      return reservation('BUDGET_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
    }
  }
}
