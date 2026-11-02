import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db, MongoServerError, ObjectId, WriteConcern } from 'mongodb';
import { MONGO_DB } from '../database/database.module';
import {
  EVENT_STATUSES,
  EventDocument,
  EventStatus,
  InvalidEventDocument,
  NewEvent,
} from './event.document';

const EVENTS_COLLECTION = 'events';
const DUPLICATE_KEY_ERROR = 11000;

// The 202 is a promise to the sender; it must only be made once the write survives a crash
// and a primary failover.
const DURABLE_WRITE: { writeConcern: WriteConcern } = {
  writeConcern: new WriteConcern('majority', undefined, true),
};

// How many due events to scan, per free slot, when looking for patients to claim. Events
// of the same patient collapse into one candidate, so over-scanning compensates for that.
const CANDIDATE_OVERSCAN = 10;

@Injectable()
export class EventsRepository implements OnModuleInit {
  private readonly events: Collection<EventDocument>;
  private readonly invalidEvents: Collection<InvalidEventDocument>;

  constructor(@Inject(MONGO_DB) db: Db) {
    // Same collection, two typed views: invalid payloads have none of the valid fields.
    this.events = db.collection(EVENTS_COLLECTION);
    this.invalidEvents = db.collection(EVENTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.events.createIndexes([
      {
        // Deduplication. Partial, because invalid events carry no patientId/type/ts and
        // would otherwise all collide on the null key.
        key: { patientId: 1, type: 1, ts: 1 },
        unique: true,
        partialFilterExpression: { patientId: { $exists: true } },
      },
      // Finding claimable patients, ordered oldest-first.
      { key: { status: 1, nextAttemptAt: 1 } },
      // Loading one patient's batch and its processed history, already in fold order.
      { key: { patientId: 1, status: 1, ts: 1, _id: 1 } },
      // The reaper.
      { key: { status: 1, leaseExpiresAt: 1 }, partialFilterExpression: { status: 'processing' } },
    ]);
  }

  // ---- Ingest -------------------------------------------------------------------------

  /** Returns the id of the stored event; on a duplicate, the id of the original. */
  async insertPending(event: NewEvent): Promise<ObjectId> {
    const now = new Date();
    try {
      const { insertedId } = await this.events.insertOne(
        { _id: new ObjectId(), ...event, status: 'pending', attempts: 0, nextAttemptAt: now, receivedAt: now },
        DURABLE_WRITE,
      );
      return insertedId;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const { patientId, type, ts } = event;
      const original = await this.events.findOne({ patientId, type, ts }, { projection: { _id: 1 } });
      if (!original) throw error;
      return original._id;
    }
  }

  async insertInvalid(raw: unknown, validationErrors: string[]): Promise<ObjectId> {
    const { insertedId } = await this.invalidEvents.insertOne(
      { status: 'invalid', raw, validationErrors, receivedAt: new Date() } as InvalidEventDocument,
      DURABLE_WRITE,
    );
    return insertedId;
  }

  async countByStatus(): Promise<Record<EventStatus, number>> {
    const rows = await this.events
      .aggregate<{ _id: EventStatus; count: number }>([{ $group: { _id: '$status', count: { $sum: 1 } } }])
      .toArray();
    const counts = Object.fromEntries(EVENT_STATUSES.map((status) => [status, 0])) as Record<EventStatus, number>;
    for (const { _id, count } of rows) counts[_id] = count;
    return counts;
  }

  // ---- Claiming and processing ----------------------------------------------------------

  /** Patients with due work, oldest first, excluding ones this process is already handling. */
  async findPatientsWithDueEvents(excluding: string[], limit: number): Promise<string[]> {
    const due = await this.events
      .find(
        { status: 'pending', nextAttemptAt: { $lte: new Date() }, patientId: { $nin: excluding } },
        { projection: { patientId: 1 } },
      )
      .sort({ nextAttemptAt: 1 })
      .limit(limit * CANDIDATE_OVERSCAN)
      .toArray();
    return [...new Set(due.map((event) => event.patientId))].slice(0, limit);
  }

  /**
   * Takes the oldest due events of a patient and marks them `processing`. Safe without a
   * conditional update because the caller holds the patient's lease: nobody else touches
   * this patient's pending events.
   */
  async claimDueEvents(patientId: string, limit: number, leaseExpiresAt: Date): Promise<EventDocument[]> {
    const due = await this.events
      .find({ patientId, status: 'pending', nextAttemptAt: { $lte: new Date() } })
      .sort({ ts: 1, _id: 1 })
      .limit(limit)
      .toArray();
    if (due.length > 0) {
      await this.events.updateMany(
        { _id: { $in: due.map((event) => event._id) } },
        { $set: { status: 'processing', leaseExpiresAt } },
      );
    }
    return due;
  }

  async extendLease(ids: ObjectId[], leaseExpiresAt: Date): Promise<void> {
    await this.events.updateMany({ _id: { $in: ids }, status: 'processing' }, { $set: { leaseExpiresAt } });
  }

  async findProcessed(patientId: string): Promise<EventDocument[]> {
    return this.events.find({ patientId, status: 'processed' }).sort({ ts: 1, _id: 1 }).toArray();
  }

  async markProcessed(ids: ObjectId[]): Promise<void> {
    await this.events.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'processed', processedAt: new Date() }, $unset: { leaseExpiresAt: '' } },
    );
  }

  async scheduleRetry(id: ObjectId, nextAttemptAt: Date, error: string): Promise<void> {
    await this.events.updateOne(
      { _id: id },
      {
        $set: { status: 'pending', nextAttemptAt, lastError: error },
        $inc: { attempts: 1 },
        $unset: { leaseExpiresAt: '' },
      },
    );
  }

  async markFailed(ids: ObjectId[], error: string): Promise<void> {
    await this.events.updateMany(
      { _id: { $in: ids } },
      { $set: { status: 'failed', lastError: error }, $inc: { attempts: 1 }, $unset: { leaseExpiresAt: '' } },
    );
  }

  // ---- Recovery -------------------------------------------------------------------------

  /**
   * Returns work abandoned by a dead worker to `pending`. Each recovery counts as an attempt,
   * so an event that crashes its worker every time ends up `failed` instead of looping forever.
   */
  async releaseExpired(maxAttempts: number): Promise<number> {
    const expired = { status: 'processing' as const, leaseExpiresAt: { $lt: new Date() } };

    await this.events.updateMany(
      { ...expired, attempts: { $gte: maxAttempts - 1 } },
      {
        $set: { status: 'failed', lastError: 'lease expired repeatedly; worker likely crashed on this event' },
        $inc: { attempts: 1 },
        $unset: { leaseExpiresAt: '' },
      },
    );
    const { modifiedCount } = await this.events.updateMany(expired, {
      $set: { status: 'pending' },
      $inc: { attempts: 1 },
      $unset: { leaseExpiresAt: '' },
    });
    return modifiedCount;
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === DUPLICATE_KEY_ERROR;
}
