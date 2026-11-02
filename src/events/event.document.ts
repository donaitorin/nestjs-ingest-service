import { ObjectId } from 'mongodb';
import { DomainEvent } from '../domain';

export type EventStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'invalid';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'pending',
  'processing',
  'processed',
  'failed',
  'invalid',
];

/** The `events` collection is the source of truth; everything else is derived from it. */
export interface EventDocument {
  _id: ObjectId;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  /** A Date, never a string, so equivalent instants in different timezones share one dedupe key. */
  ts: Date;
  status: Exclude<EventStatus, 'invalid'>;
  attempts: number;
  /** Backoff gate: the event is not claimable before this instant. */
  nextAttemptAt: Date;
  /** Set only while `processing`; the reaper uses it to detect abandoned work. */
  leaseExpiresAt?: Date;
  lastError?: string;
  receivedAt: Date;
  processedAt?: Date;
}

/** Malformed payloads are kept verbatim: "never lose an event" includes the ones we can't parse. */
export interface InvalidEventDocument {
  _id: ObjectId;
  status: 'invalid';
  raw: unknown;
  validationErrors: string[];
  receivedAt: Date;
}

export type NewEvent = Pick<EventDocument, 'patientId' | 'type' | 'data' | 'ts'>;

export const toDomainEvent = (event: EventDocument): DomainEvent => ({
  id: event._id.toHexString(),
  type: event.type,
  data: event.data,
  ts: event.ts,
});
