import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementResultingChanges } from "node:sqlite";

export const ACTIVE_RESERVATION_STATES = ["reserved", "submitting", "uncertain", "committed"] as const;
export type RiskReservationState = (typeof ACTIVE_RESERVATION_STATES)[number] | "released";

export type ExistingOpenPosition = {
  tradeId: string;
  date: string;
  matchKey: string;
  exposureUsd: number;
  venueExposureUsd: Record<string, number>;
};

export type AcquireRiskReservationInput = {
  opportunityId: string;
  idempotencyKey: string;
  quoteGeneration: string;
  matchKey: string;
  date: string;
  ownerId: string;
  exposureUsd: number;
  venueExposureUsd: Record<string, number>;
  maxExposureUsd: number;
  maxOpenPositionsPerMatch: number;
  perVenueCapsUsd: Record<string, number>;
  existingOpenPositions: ExistingOpenPosition[];
  legs?: ReservationLegPlan[];
  ttlMs?: number;
};

export type ReservationLegPlan = {
  venueId: string;
  marketId: string;
  nativeMarketId?: string;
  nativeSide?: string;
  outcome: string;
  sizeContracts: number;
  limitPriceCents: number;
};

export type ReservationLeg = ReservationLegPlan & {
  index: number;
  clientOrderId: string;
  submissionState: "planned" | "submitting" | "acknowledged" | "uncertain";
  venueOrderId: string | null;
  confirmationId: string | null;
  filledContracts: number;
  averagePriceCents: number | null;
  resultStatus: string | null;
  error: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
};

export type RecoveryAttempt = {
  reservationId: string;
  legIndex: number;
  attemptNumber: number;
  clientOrderId: string;
  sizeContracts: number;
  limitPriceCents: number;
  submissionState: "planned" | "submitting" | "acknowledged" | "uncertain";
  venueOrderId: string | null;
  confirmationId: string | null;
  filledContracts: number;
  averagePriceCents: number | null;
  resultStatus: string | null;
  error: string | null;
  submittedAt: string | null;
  acknowledgedAt: string | null;
};

export type AllocateRecoveryAttemptResult =
  | { ok: true; attempt: RecoveryAttempt }
  | { ok: false; code: "not_terminal" | "active" | "exhausted" | "fenced"; reason: string };

export type RiskReservationEvent = {
  id: number;
  reservationId: string;
  legIndex: number | null;
  type: string;
  details: Record<string, unknown>;
  createdAt: string;
};

export type RiskReservation = {
  id: string;
  fencingToken: number;
  state: RiskReservationState;
  opportunityId: string;
  idempotencyKey: string;
  quoteGeneration: string;
  matchKey: string;
  date: string;
  ownerId: string;
  exposureUsd: number;
  venueExposureUsd: Record<string, number>;
  tradeId: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  legs: ReservationLeg[];
  recoveryAttempts: RecoveryAttempt[];
};

export type AcquireRiskReservationResult =
  | { ok: true; reservation: RiskReservation }
  | { ok: false; code: "duplicate" | "match_cap" | "exposure_cap" | "venue_cap" | "ledger_unavailable"; reason: string };

export type ReservationLease = Pick<RiskReservation, "id" | "fencingToken" | "ownerId">;

const USD_SCALE = 1_000_000;
const DEFAULT_TTL_MS = 15_000;
const DEFAULT_DB_FILE = path.join(process.cwd(), "data", "arbitrage", "risk-ledger.sqlite");
const ACTIVE_SQL = "'reserved','submitting','uncertain','committed'";

function toMicros(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`Invalid non-negative USD amount: ${usd}`);
  return Math.round(usd * USD_SCALE);
}

function fromMicros(value: unknown): number {
  return Number(value ?? 0) / USD_SCALE;
}

function parseVenueMicros(value: unknown): Record<string, number> {
  if (typeof value !== "string") return {};
  const raw = JSON.parse(value) as Record<string, number>;
  return Object.fromEntries(Object.entries(raw).map(([venue, micros]) => [venue, fromMicros(micros)]));
}

function venueMicros(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([venue, usd]) => [venue, toMicros(usd)]));
}

type ReservationRow = Record<string, unknown>;

function mapReservation(row: ReservationRow): RiskReservation {
  return {
    id: String(row.id),
    fencingToken: Number(row.fencing_token),
    state: String(row.state) as RiskReservationState,
    opportunityId: String(row.opportunity_id),
    idempotencyKey: String(row.idempotency_key),
    quoteGeneration: String(row.quote_generation),
    matchKey: String(row.match_key),
    date: String(row.date),
    ownerId: String(row.owner_id),
    exposureUsd: fromMicros(row.exposure_micros),
    venueExposureUsd: parseVenueMicros(row.venue_exposure_json),
    tradeId: row.trade_id == null ? null : String(row.trade_id),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    legs: [],
    recoveryAttempts: [],
  };
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = (["8", "9", "a", "b"] as const)[parseInt(hex[16], 16) % 4];
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function deterministicClientOrderId(reservationId: string, legIndex: number): string {
  return deterministicUuid(`${reservationId}:leg:${legIndex}:primary`);
}

function deterministicRecoveryClientOrderId(reservationId: string, legIndex: number, attemptNumber: number): string {
  return deterministicUuid(`${reservationId}:leg:${legIndex}:recovery:${attemptNumber}`);
}

function changed(result: StatementResultingChanges): boolean {
  return Number(result.changes) === 1;
}

/**
 * Durable, process-safe risk authority. All cap checks and the reservation insert occur
 * inside one BEGIN IMMEDIATE transaction. Venue calls must never be made from this class.
 */
export class RiskReservationService {
  private readonly db: DatabaseSync;

  constructor(dbFile = DEFAULT_DB_FILE) {
    if (dbFile !== ":memory:") fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile, { timeout: 5_000 });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    // WAL negotiation and first-run DDL both take a write lock. Independent server
    // processes may initialize simultaneously after a restart, so make initialization
    // itself contention-safe instead of failing before the transactional ledger starts.
    let initialized = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 20 && !initialized; attempt += 1) {
      try {
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
        this.migrate();
        initialized = true;
      } catch (error) {
        lastError = error;
        if (!String(error).toLowerCase().includes("locked")) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + attempt * 10);
      }
    }
    if (!initialized) {
      this.db.close();
      throw lastError instanceof Error ? lastError : new Error(`Risk ledger initialization failed: ${String(lastError)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_reservations (
        fencing_token INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        opportunity_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        quote_generation TEXT NOT NULL,
        match_key TEXT NOT NULL,
        date TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','submitting','uncertain','committed','released')),
        exposure_micros INTEGER NOT NULL CHECK (exposure_micros >= 0),
        venue_exposure_json TEXT NOT NULL,
        trade_id TEXT,
        expires_at TEXT,
        release_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS risk_reservations_active_idempotency
        ON risk_reservations(idempotency_key) WHERE state IN (${ACTIVE_SQL});
      CREATE UNIQUE INDEX IF NOT EXISTS risk_reservations_trade_id
        ON risk_reservations(trade_id) WHERE trade_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS risk_reservations_active_match
        ON risk_reservations(match_key, state);

      CREATE TABLE IF NOT EXISTS legacy_open_positions (
        trade_id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        match_key TEXT NOT NULL,
        exposure_micros INTEGER NOT NULL CHECK (exposure_micros >= 0),
        venue_exposure_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS legacy_open_positions_match
        ON legacy_open_positions(match_key);

      CREATE TABLE IF NOT EXISTS risk_reservation_legs (
        reservation_id TEXT NOT NULL REFERENCES risk_reservations(id) ON DELETE CASCADE,
        leg_index INTEGER NOT NULL,
        venue_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        native_market_id TEXT,
        native_side TEXT,
        outcome TEXT NOT NULL,
        size_micros INTEGER NOT NULL CHECK (size_micros > 0),
        limit_price_micros INTEGER NOT NULL CHECK (limit_price_micros > 0),
        client_order_id TEXT NOT NULL UNIQUE,
        submission_state TEXT NOT NULL CHECK (submission_state IN ('planned','submitting','acknowledged','uncertain')),
        venue_order_id TEXT,
        confirmation_id TEXT,
        filled_micros INTEGER NOT NULL DEFAULT 0 CHECK (filled_micros >= 0),
        average_price_micros INTEGER,
        result_status TEXT,
        error TEXT,
        submitted_at TEXT,
        acknowledged_at TEXT,
        PRIMARY KEY(reservation_id, leg_index)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS risk_reservation_legs_submission
        ON risk_reservation_legs(submission_state, venue_id);

      CREATE TABLE IF NOT EXISTS risk_recovery_attempts (
        reservation_id TEXT NOT NULL,
        leg_index INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        client_order_id TEXT NOT NULL UNIQUE,
        size_micros INTEGER NOT NULL CHECK (size_micros > 0),
        limit_price_micros INTEGER NOT NULL CHECK (limit_price_micros > 0),
        submission_state TEXT NOT NULL CHECK (submission_state IN ('planned','submitting','acknowledged','uncertain')),
        venue_order_id TEXT,
        confirmation_id TEXT,
        filled_micros INTEGER NOT NULL DEFAULT 0 CHECK (filled_micros >= 0),
        average_price_micros INTEGER,
        result_status TEXT,
        error TEXT,
        submitted_at TEXT,
        acknowledged_at TEXT,
        PRIMARY KEY(reservation_id, leg_index, attempt_number),
        FOREIGN KEY(reservation_id, leg_index)
          REFERENCES risk_reservation_legs(reservation_id, leg_index) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS risk_recovery_attempts_active
        ON risk_recovery_attempts(reservation_id, leg_index, submission_state);

      CREATE TABLE IF NOT EXISTS risk_reservation_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id TEXT NOT NULL REFERENCES risk_reservations(id) ON DELETE CASCADE,
        leg_index INTEGER,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS risk_reservation_events_reservation
        ON risk_reservation_events(reservation_id, event_id);
    `);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
  }

  private databaseNowMs(): number {
    const row = this.db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms").get() as ReservationRow;
    const nowMs = Number(row.now_ms);
    if (!Number.isFinite(nowMs)) throw new Error("SQLite did not provide a valid reservation clock");
    return nowMs;
  }

  private appendEvent(reservationId: string, legIndex: number | null, type: string, details: Record<string, unknown>, now: string): void {
    this.db.prepare("INSERT INTO risk_reservation_events(reservation_id,leg_index,event_type,detail_json,created_at) VALUES(?,?,?,?,?)")
      .run(reservationId, legIndex, type, JSON.stringify(details), now);
  }

  private syncLegacyPositions(positions: ExistingOpenPosition[], now: string): void {
    if (positions.length === 0) {
      this.db.exec("DELETE FROM legacy_open_positions");
    } else {
      const placeholders = positions.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM legacy_open_positions WHERE trade_id NOT IN (${placeholders})`).run(...positions.map((p) => p.tradeId));
    }
    const upsert = this.db.prepare(`
      INSERT INTO legacy_open_positions(trade_id,date,match_key,exposure_micros,venue_exposure_json,observed_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(trade_id) DO UPDATE SET
        date=excluded.date, match_key=excluded.match_key, exposure_micros=excluded.exposure_micros,
        venue_exposure_json=excluded.venue_exposure_json, observed_at=excluded.observed_at
    `);
    for (const position of positions) {
      upsert.run(position.tradeId, position.date, position.matchKey, toMicros(position.exposureUsd), JSON.stringify(venueMicros(position.venueExposureUsd)), now);
    }
    // A trade created from a reservation is represented by that reservation, never twice.
    this.db.exec("DELETE FROM legacy_open_positions WHERE trade_id IN (SELECT trade_id FROM risk_reservations WHERE trade_id IS NOT NULL)");
  }

  acquire(input: AcquireRiskReservationInput): AcquireRiskReservationResult {
    try {
      return this.transaction(() => {
        const nowMs = this.databaseNowMs();
        const now = new Date(nowMs).toISOString();
        // Only never-submitted reservations expire automatically. submitting/uncertain are
        // deliberately exposure-blocking until explicit reconciliation proves the outcome.
        this.db.prepare("UPDATE risk_reservations SET state='released', release_reason='expired_before_submission', updated_at=? WHERE state='reserved' AND expires_at <= ?").run(now, now);
        this.syncLegacyPositions(input.existingOpenPositions, now);

        const duplicate = this.db.prepare(`SELECT id FROM risk_reservations WHERE idempotency_key=? AND state IN (${ACTIVE_SQL}) LIMIT 1`).get(input.idempotencyKey);
        if (duplicate) return { ok: false, code: "duplicate", reason: "An active reservation already owns this opportunity and quote generation" };

        const activeForMatch = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM risk_reservations WHERE match_key=? AND state IN (${ACTIVE_SQL})`).get(input.matchKey) as ReservationRow)?.count ?? 0);
        const legacyForMatch = Number((this.db.prepare("SELECT COUNT(*) AS count FROM legacy_open_positions WHERE match_key=?").get(input.matchKey) as ReservationRow)?.count ?? 0);
        if (input.maxOpenPositionsPerMatch > 0 && activeForMatch + legacyForMatch >= input.maxOpenPositionsPerMatch) {
          return { ok: false, code: "match_cap", reason: `Atomic match cap reached: ${activeForMatch + legacyForMatch}/${input.maxOpenPositionsPerMatch} open or reserved` };
        }

        const reservedMicros = Number((this.db.prepare(`SELECT COALESCE(SUM(exposure_micros),0) AS total FROM risk_reservations WHERE state IN (${ACTIVE_SQL})`).get() as ReservationRow)?.total ?? 0);
        const legacyMicros = Number((this.db.prepare("SELECT COALESCE(SUM(exposure_micros),0) AS total FROM legacy_open_positions").get() as ReservationRow)?.total ?? 0);
        const requestedMicros = toMicros(input.exposureUsd);
        const maxMicros = toMicros(input.maxExposureUsd);
        if (reservedMicros + legacyMicros + requestedMicros > maxMicros) {
          return { ok: false, code: "exposure_cap", reason: `Atomic exposure cap exceeded: $${fromMicros(reservedMicros + legacyMicros + requestedMicros).toFixed(2)} > $${input.maxExposureUsd.toFixed(2)}` };
        }

        const activeRows = this.db.prepare(`SELECT venue_exposure_json FROM risk_reservations WHERE state IN (${ACTIVE_SQL})`).all() as ReservationRow[];
        const legacyRows = this.db.prepare("SELECT venue_exposure_json FROM legacy_open_positions").all() as ReservationRow[];
        const currentlyReserved: Record<string, number> = {};
        for (const row of [...activeRows, ...legacyRows]) {
          const values = parseVenueMicros(row.venue_exposure_json);
          for (const [venue, usd] of Object.entries(values)) currentlyReserved[venue] = (currentlyReserved[venue] ?? 0) + usd;
        }
        for (const [venue, requestedUsd] of Object.entries(input.venueExposureUsd)) {
          const cap = input.perVenueCapsUsd[venue];
          if (cap != null && cap > 0 && (currentlyReserved[venue] ?? 0) + requestedUsd > cap) {
            return { ok: false, code: "venue_cap", reason: `${venue} atomic cap exceeded: $${((currentlyReserved[venue] ?? 0) + requestedUsd).toFixed(2)} > $${cap.toFixed(2)}` };
          }
        }

        const id = randomUUID();
        const expiresAt = new Date(nowMs + Math.max(1, input.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
        this.db.prepare(`
          INSERT INTO risk_reservations(id,opportunity_id,idempotency_key,quote_generation,match_key,date,owner_id,state,exposure_micros,venue_exposure_json,expires_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'reserved',?,?,?,?,?)
        `).run(id, input.opportunityId, input.idempotencyKey, input.quoteGeneration, input.matchKey, input.date, input.ownerId, requestedMicros, JSON.stringify(venueMicros(input.venueExposureUsd)), expiresAt, now, now);
        const insertLeg = this.db.prepare(`
          INSERT INTO risk_reservation_legs(
            reservation_id,leg_index,venue_id,market_id,native_market_id,native_side,outcome,
            size_micros,limit_price_micros,client_order_id,submission_state
          ) VALUES(?,?,?,?,?,?,?,?,?,?,'planned')
        `);
        for (const [index, leg] of (input.legs ?? []).entries()) {
          insertLeg.run(
            id, index, leg.venueId, leg.marketId, leg.nativeMarketId ?? null, leg.nativeSide ?? null,
            leg.outcome, toMicros(leg.sizeContracts), toMicros(leg.limitPriceCents), deterministicClientOrderId(id, index)
          );
        }
        this.appendEvent(id, null, "reserved", {
          exposureUsd: input.exposureUsd,
          venueExposureUsd: input.venueExposureUsd,
          matchKey: input.matchKey,
          quoteGeneration: input.quoteGeneration,
        }, now);
        return { ok: true, reservation: this.getRequired(id) };
      });
    } catch (error) {
      return { ok: false, code: "ledger_unavailable", reason: `Risk ledger unavailable; live execution fails closed: ${String(error)}` };
    }
  }

  beginSubmission(lease: ReservationLease): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      this.db.prepare("UPDATE risk_reservations SET state='released', release_reason='expired_before_submission', updated_at=? WHERE state='reserved' AND expires_at <= ?").run(now, now);
      const ok = changed(this.db.prepare("UPDATE risk_reservations SET state='submitting', expires_at=NULL, updated_at=? WHERE id=? AND fencing_token=? AND owner_id=? AND state='reserved'").run(now, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, null, "submission_started", { fencingToken: lease.fencingToken, ownerId: lease.ownerId }, now);
      return ok;
    });
  }

  markLegSubmitting(lease: ReservationLease, legIndex: number): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
      UPDATE risk_reservation_legs SET submission_state='submitting', submitted_at=?
      WHERE reservation_id=? AND leg_index=? AND submission_state='planned'
        AND EXISTS (
          SELECT 1 FROM risk_reservations
          WHERE id=? AND fencing_token=? AND owner_id=? AND state='submitting'
        )
      `).run(now, lease.id, legIndex, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, legIndex, "leg_submission_started", {}, now);
      return ok;
    });
  }

  recordLegResult(lease: ReservationLease, legIndex: number, result: {
    orderId: string | null;
    confirmationId?: string | null;
    filledContracts: number;
    avgPriceCents: number;
    status: string;
    error?: string;
  }): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
      UPDATE risk_reservation_legs SET
        submission_state='acknowledged', venue_order_id=?, confirmation_id=?, filled_micros=?,
        average_price_micros=?, result_status=?, error=?, acknowledged_at=?
      WHERE reservation_id=? AND leg_index=? AND submission_state IN ('submitting','uncertain','acknowledged')
        AND EXISTS (
          SELECT 1 FROM risk_reservations
          WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain','committed')
        )
    `).run(
      result.orderId, result.confirmationId ?? null, toMicros(result.filledContracts),
      toMicros(result.avgPriceCents), result.status, result.error ?? null,
      now, lease.id, legIndex,
      lease.id, lease.fencingToken, lease.ownerId
      ));
      if (ok) this.appendEvent(lease.id, legIndex, "leg_acknowledged", {
        orderId: result.orderId,
        confirmationId: result.confirmationId ?? null,
        filledContracts: result.filledContracts,
        averagePriceCents: result.avgPriceCents,
        status: result.status,
        error: result.error ?? null,
      }, now);
      return ok;
    });
  }

  markLegUncertain(lease: ReservationLease, legIndex: number, error: string): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
      UPDATE risk_reservation_legs SET submission_state='uncertain', error=?, acknowledged_at=?
      WHERE reservation_id=? AND leg_index=? AND submission_state='submitting'
        AND EXISTS (
          SELECT 1 FROM risk_reservations
          WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain')
        )
      `).run(error, now, lease.id, legIndex, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, legIndex, "leg_uncertain", { error }, now);
      return ok;
    });
  }

  allocateRecoveryAttempt(
    lease: ReservationLease,
    legIndex: number,
    sizeContracts: number,
    limitPriceCents: number,
    maxAttempts = 3
  ): AllocateRecoveryAttemptResult {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const owner = this.db.prepare(`
        SELECT 1 FROM risk_reservations
        WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain')
      `).get(lease.id, lease.fencingToken, lease.ownerId);
      if (!owner) return { ok: false, code: "fenced", reason: "Recovery reservation lease is no longer current" };

      const original = this.db.prepare(`
        SELECT submission_state,result_status FROM risk_reservation_legs
        WHERE reservation_id=? AND leg_index=?
      `).get(lease.id, legIndex) as ReservationRow | undefined;
      const terminalStatuses = new Set(["filled", "partial", "unfilled", "rejected"]);
      if (!original || original.submission_state !== "acknowledged" || !terminalStatuses.has(String(original.result_status ?? ""))) {
        return { ok: false, code: "not_terminal", reason: "Original venue order is not positively reconciled to a terminal result" };
      }

      const active = this.db.prepare(`
        SELECT * FROM risk_recovery_attempts
        WHERE reservation_id=? AND leg_index=? AND submission_state IN ('planned','submitting','uncertain')
        ORDER BY attempt_number DESC LIMIT 1
      `).get(lease.id, legIndex) as ReservationRow | undefined;
      if (active) {
        return { ok: false, code: "active", reason: `Recovery attempt ${Number(active.attempt_number)} is still ${String(active.submission_state)}` };
      }

      const latest = this.db.prepare(`
        SELECT COALESCE(MAX(attempt_number),0) AS attempt_number FROM risk_recovery_attempts
        WHERE reservation_id=? AND leg_index=?
      `).get(lease.id, legIndex) as ReservationRow;
      const attemptNumber = Number(latest.attempt_number ?? 0) + 1;
      if (attemptNumber > Math.max(1, Math.floor(maxAttempts))) {
        return { ok: false, code: "exhausted", reason: `Recovery attempt limit (${maxAttempts}) reached` };
      }
      const clientOrderId = deterministicRecoveryClientOrderId(lease.id, legIndex, attemptNumber);
      this.db.prepare(`
        INSERT INTO risk_recovery_attempts(
          reservation_id,leg_index,attempt_number,client_order_id,size_micros,limit_price_micros,submission_state
        ) VALUES(?,?,?,?,?,?,'planned')
      `).run(lease.id, legIndex, attemptNumber, clientOrderId, toMicros(sizeContracts), toMicros(limitPriceCents));
      this.appendEvent(lease.id, legIndex, "recovery_planned", {
        attemptNumber, clientOrderId, sizeContracts, limitPriceCents,
      }, now);
      const attempt = this.getRecoveryAttempts(lease.id).find((candidate) =>
        candidate.legIndex === legIndex && candidate.attemptNumber === attemptNumber
      );
      if (!attempt) throw new Error("Persisted recovery attempt could not be read back");
      return { ok: true, attempt };
    });
  }

  markRecoverySubmitting(lease: ReservationLease, legIndex: number, attemptNumber: number): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
        UPDATE risk_recovery_attempts SET submission_state='submitting', submitted_at=?
        WHERE reservation_id=? AND leg_index=? AND attempt_number=? AND submission_state='planned'
          AND EXISTS (
            SELECT 1 FROM risk_reservations
            WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain')
          )
      `).run(now, lease.id, legIndex, attemptNumber, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, legIndex, "recovery_submission_started", { attemptNumber }, now);
      return ok;
    });
  }

  recordRecoveryResult(lease: ReservationLease, legIndex: number, attemptNumber: number, result: {
    orderId: string | null;
    confirmationId?: string | null;
    filledContracts: number;
    avgPriceCents: number;
    status: string;
    error?: string;
  }): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
        UPDATE risk_recovery_attempts SET
          submission_state=CASE WHEN ?='pending' THEN 'uncertain' ELSE 'acknowledged' END,
          venue_order_id=?, confirmation_id=?, filled_micros=?,
          average_price_micros=?, result_status=?, error=?, acknowledged_at=?
        WHERE reservation_id=? AND leg_index=? AND attempt_number=?
          AND submission_state IN ('planned','submitting','uncertain','acknowledged')
          AND EXISTS (
            SELECT 1 FROM risk_reservations
            WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain','committed')
          )
      `).run(
        result.status, result.orderId, result.confirmationId ?? null, toMicros(result.filledContracts),
        toMicros(result.avgPriceCents), result.status, result.error ?? null, now,
        lease.id, legIndex, attemptNumber, lease.id, lease.fencingToken, lease.ownerId
      ));
      if (ok) this.appendEvent(lease.id, legIndex, "recovery_acknowledged", {
        attemptNumber,
        orderId: result.orderId,
        confirmationId: result.confirmationId ?? null,
        filledContracts: result.filledContracts,
        averagePriceCents: result.avgPriceCents,
        status: result.status,
        error: result.error ?? null,
      }, now);
      return ok;
    });
  }

  markRecoveryUncertain(lease: ReservationLease, legIndex: number, attemptNumber: number, error: string): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
        UPDATE risk_recovery_attempts SET submission_state='uncertain', error=?, acknowledged_at=?
        WHERE reservation_id=? AND leg_index=? AND attempt_number=? AND submission_state='submitting'
          AND EXISTS (
            SELECT 1 FROM risk_reservations
            WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain')
          )
      `).run(error, now, lease.id, legIndex, attemptNumber, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, legIndex, "recovery_uncertain", { attemptNumber, error }, now);
      return ok;
    });
  }

  markCommitted(lease: ReservationLease, tradeId: string): boolean {
    return this.transitionAfterSubmission(lease, "committed", tradeId, null);
  }

  markUncertain(lease: ReservationLease, tradeId: string | null, reason: string): boolean {
    return this.transitionAfterSubmission(lease, "uncertain", tradeId, reason);
  }

  private transitionAfterSubmission(lease: ReservationLease, state: "committed" | "uncertain", tradeId: string | null, reason: string | null): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
      UPDATE risk_reservations SET state=?, trade_id=COALESCE(?,trade_id), release_reason=?, updated_at=?
      WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain','committed')
      `).run(state, tradeId, reason, now, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, null, `reservation_${state}`, { tradeId, reason }, now);
      return ok;
    });
  }

  releaseBeforeSubmission(lease: ReservationLease, reason: string): boolean {
    return this.releaseWithFence(lease, reason, "state='reserved'", "released_before_submission");
  }

  releaseAfterConfirmedNoFill(lease: ReservationLease, reason: string): boolean {
    return this.releaseWithFence(lease, reason, "state='submitting'", "released_confirmed_zero_fill");
  }

  private releaseWithFence(lease: ReservationLease, reason: string, statePredicate: string, eventType: string): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`UPDATE risk_reservations SET state='released', release_reason=?, updated_at=? WHERE id=? AND fencing_token=? AND owner_id=? AND ${statePredicate}`)
        .run(reason, now, lease.id, lease.fencingToken, lease.ownerId));
      if (ok) this.appendEvent(lease.id, null, eventType, { reason }, now);
      return ok;
    });
  }

  releaseAfterReconciledZeroFill(lease: ReservationLease, reason: string): boolean {
    return this.transaction(() => {
      const now = new Date(this.databaseNowMs()).toISOString();
      const ok = changed(this.db.prepare(`
      UPDATE risk_reservations SET state='released', release_reason=?, updated_at=?
      WHERE id=? AND fencing_token=? AND owner_id=? AND state IN ('submitting','uncertain')
        AND EXISTS (SELECT 1 FROM risk_reservation_legs WHERE reservation_id=?)
        AND NOT EXISTS (
          SELECT 1 FROM risk_reservation_legs
          WHERE reservation_id=? AND (
            submission_state != 'acknowledged' OR filled_micros != 0 OR result_status IS NULL OR result_status NOT IN ('unfilled','rejected')
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM risk_recovery_attempts
          WHERE reservation_id=? AND (
            submission_state != 'acknowledged' OR filled_micros != 0 OR result_status IS NULL OR result_status NOT IN ('unfilled','rejected')
          )
        )
      `).run(
      reason, now, lease.id, lease.fencingToken,
      lease.ownerId, lease.id, lease.id, lease.id
      ));
      if (ok) this.appendEvent(lease.id, null, "released_after_reconciliation", { reason }, now);
      return ok;
    });
  }

  releaseByTradeId(tradeId: string, reason = "trade_closed"): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT id FROM risk_reservations WHERE trade_id=? AND state IN ('uncertain','committed')").get(tradeId) as ReservationRow | undefined;
      if (!row) return false;
      const now = new Date(this.databaseNowMs()).toISOString();
      const reservationId = String(row.id);
      const ok = changed(this.db.prepare("UPDATE risk_reservations SET state='released', release_reason=?, updated_at=? WHERE id=? AND state IN ('uncertain','committed')").run(reason, now, reservationId));
      if (ok) this.appendEvent(reservationId, null, "released_trade_terminal", { tradeId, reason }, now);
      return ok;
    });
  }

  get(id: string): RiskReservation | null {
    const row = this.db.prepare("SELECT * FROM risk_reservations WHERE id=?").get(id) as ReservationRow | undefined;
    if (!row) return null;
    const reservation = mapReservation(row);
    reservation.legs = this.getLegs(id);
    reservation.recoveryAttempts = this.getRecoveryAttempts(id);
    return reservation;
  }

  private getLegs(reservationId: string): ReservationLeg[] {
    const rows = this.db.prepare("SELECT * FROM risk_reservation_legs WHERE reservation_id=? ORDER BY leg_index").all(reservationId) as ReservationRow[];
    return rows.map((row) => ({
      index: Number(row.leg_index),
      venueId: String(row.venue_id),
      marketId: String(row.market_id),
      nativeMarketId: row.native_market_id == null ? undefined : String(row.native_market_id),
      nativeSide: row.native_side == null ? undefined : String(row.native_side),
      outcome: String(row.outcome),
      sizeContracts: fromMicros(row.size_micros),
      limitPriceCents: fromMicros(row.limit_price_micros),
      clientOrderId: String(row.client_order_id),
      submissionState: String(row.submission_state) as ReservationLeg["submissionState"],
      venueOrderId: row.venue_order_id == null ? null : String(row.venue_order_id),
      confirmationId: row.confirmation_id == null ? null : String(row.confirmation_id),
      filledContracts: fromMicros(row.filled_micros),
      averagePriceCents: row.average_price_micros == null ? null : fromMicros(row.average_price_micros),
      resultStatus: row.result_status == null ? null : String(row.result_status),
      error: row.error == null ? null : String(row.error),
      submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
      acknowledgedAt: row.acknowledged_at == null ? null : String(row.acknowledged_at),
    }));
  }

  getRecoveryAttempts(reservationId: string): RecoveryAttempt[] {
    const rows = this.db.prepare(`
      SELECT * FROM risk_recovery_attempts
      WHERE reservation_id=? ORDER BY leg_index,attempt_number
    `).all(reservationId) as ReservationRow[];
    return rows.map((row) => ({
      reservationId: String(row.reservation_id),
      legIndex: Number(row.leg_index),
      attemptNumber: Number(row.attempt_number),
      clientOrderId: String(row.client_order_id),
      sizeContracts: fromMicros(row.size_micros),
      limitPriceCents: fromMicros(row.limit_price_micros),
      submissionState: String(row.submission_state) as RecoveryAttempt["submissionState"],
      venueOrderId: row.venue_order_id == null ? null : String(row.venue_order_id),
      confirmationId: row.confirmation_id == null ? null : String(row.confirmation_id),
      filledContracts: fromMicros(row.filled_micros),
      averagePriceCents: row.average_price_micros == null ? null : fromMicros(row.average_price_micros),
      resultStatus: row.result_status == null ? null : String(row.result_status),
      error: row.error == null ? null : String(row.error),
      submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
      acknowledgedAt: row.acknowledged_at == null ? null : String(row.acknowledged_at),
    }));
  }

  listEvents(limit = 500): RiskReservationEvent[] {
    const safeLimit = Math.max(1, Math.min(5_000, Math.floor(limit)));
    const rows = this.db.prepare("SELECT * FROM risk_reservation_events ORDER BY event_id DESC LIMIT ?").all(safeLimit) as ReservationRow[];
    return rows.map((row) => ({
      id: Number(row.event_id),
      reservationId: String(row.reservation_id),
      legIndex: row.leg_index == null ? null : Number(row.leg_index),
      type: String(row.event_type),
      details: typeof row.detail_json === "string" ? JSON.parse(row.detail_json) as Record<string, unknown> : {},
      createdAt: String(row.created_at),
    }));
  }

  private getRequired(id: string): RiskReservation {
    const reservation = this.get(id);
    if (!reservation) throw new Error(`Reservation ${id} disappeared inside its transaction`);
    return reservation;
  }

  list(): RiskReservation[] {
    return (this.db.prepare("SELECT * FROM risk_reservations ORDER BY fencing_token").all() as ReservationRow[]).map((row) => {
      const reservation = mapReservation(row);
      reservation.legs = this.getLegs(reservation.id);
      reservation.recoveryAttempts = this.getRecoveryAttempts(reservation.id);
      return reservation;
    });
  }

  close(): void {
    this.db.close();
  }
}

const RESERVATION_SERVICE_VERSION = 3;
const singleton = globalThis as typeof globalThis & {
  __arbRiskReservationService?: RiskReservationService;
  __arbRiskReservationServiceVersion?: number;
};

export function getRiskReservationService(): RiskReservationService {
  // Next.js development hot reload preserves globalThis while replacing module classes.
  // Recreate the singleton when its schema/API version changes so an old prototype can
  // never serve a newly compiled execution path.
  if (!singleton.__arbRiskReservationService || singleton.__arbRiskReservationServiceVersion !== RESERVATION_SERVICE_VERSION) {
    try { singleton.__arbRiskReservationService?.close(); } catch { /* replace stale HMR instance */ }
    singleton.__arbRiskReservationService = new RiskReservationService();
    singleton.__arbRiskReservationServiceVersion = RESERVATION_SERVICE_VERSION;
  }
  return singleton.__arbRiskReservationService;
}

export function releaseReservationForTrade(tradeId: string, reason?: string): boolean {
  return getRiskReservationService().releaseByTradeId(tradeId, reason);
}
