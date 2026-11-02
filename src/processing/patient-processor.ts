import { Inject, Injectable, Logger } from '@nestjs/common';
import appConfig, { AppConfig } from '../config/app.config';
import { foldPatientState } from '../domain';
import { EventDocument, toDomainEvent } from '../events/event.document';
import { EventsRepository } from '../events/events.repository';
import { ExternalSystemClient } from './external-system.client';
import { leaseExpiry } from './lease';
import { PatientsRepository } from './patients.repository';
import { decideRetry } from './retry-policy';

export interface PatientClaim {
  patientId: string;
  owner: string;
}

/** Processes one batch of one patient's events. The caller must already hold the patient's lease. */
@Injectable()
export class PatientProcessor {
  private readonly logger = new Logger(PatientProcessor.name);

  constructor(
    private readonly events: EventsRepository,
    private readonly patients: PatientsRepository,
    private readonly external: ExternalSystemClient,
    @Inject(appConfig.KEY) private readonly config: AppConfig,
  ) {}

  async process(claim: PatientClaim): Promise<void> {
    const { patientId, owner } = claim;
    try {
      const batch = await this.events.claimDueEvents(
        patientId,
        this.config.maxBatch,
        leaseExpiry(this.config.leaseMs),
      );
      if (batch.length === 0) return;

      const heartbeat = setInterval(() => void this.renewLeases(claim, batch), this.config.heartbeatMs);
      try {
        await this.processBatch(patientId, batch);
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      await this.patients.release(patientId, owner);
    }
  }

  private async processBatch(patientId: string, batch: EventDocument[]): Promise<void> {
    // allSettled: one failing call must not discard the results of its 49 siblings.
    const results = await Promise.allSettled(batch.map((event) => this.external.process(event)));

    const succeeded: EventDocument[] = [];
    const failures: Array<{ event: EventDocument; reason: string }> = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') succeeded.push(batch[i]);
      else failures.push({ event: batch[i], reason: errorMessage(result.reason) });
    });

    await this.applyToState(patientId, succeeded);
    await Promise.all(failures.map(({ event, reason }) => this.recordFailure(event, reason)));
  }

  /**
   * Refolds the patient's whole history plus this batch. Order of arrival is irrelevant because
   * the fold sorts, and a replay after a crash is the same computation, so it is idempotent.
   *
   * The state is written before the events are marked processed: a crash in between leaves the
   * events recoverable by the reaper, whereas the opposite order could mark them done with a
   * state that never reflected them.
   */
  private async applyToState(patientId: string, succeeded: EventDocument[]): Promise<void> {
    if (succeeded.length === 0) return;

    for (let attempt = 1; attempt <= this.config.maxFoldRetries; attempt++) {
      // Version first, history second: a write landing between the two bumps the version
      // and makes our save fail, rather than silently folding a stale history.
      const patient = await this.patients.get(patientId);
      const processed = await this.events.findProcessed(patientId);
      const state = foldPatientState([...processed, ...succeeded].map(toDomainEvent));

      if (await this.patients.saveState(patientId, patient?.version ?? 0, state)) {
        await this.events.markProcessed(succeeded.map((event) => event._id));
        return;
      }
      this.logger.warn(`Version conflict folding patient ${patientId} (attempt ${attempt})`);
    }

    await this.events.markFailed(
      succeeded.map((event) => event._id),
      `patient state changed concurrently; gave up after ${this.config.maxFoldRetries} attempts`,
    );
  }

  private async recordFailure(event: EventDocument, reason: string): Promise<void> {
    const decision = decideRetry(event.attempts + 1, new Date(), {
      maxAttempts: this.config.maxAttempts,
      baseDelayMs: this.config.retryBaseDelayMs,
    });
    if (decision.retry) await this.events.scheduleRetry(event._id, decision.nextAttemptAt, reason);
    else await this.events.markFailed([event._id], reason);
  }

  // Heartbeats decouple lease length from batch duration: a slow batch keeps its lease alive,
  // a dead worker stops renewing and loses it within one lease period.
  private async renewLeases({ patientId, owner }: PatientClaim, batch: EventDocument[]): Promise<void> {
    try {
      const expiresAt = leaseExpiry(this.config.leaseMs);
      const stillOwned = await this.patients.extendLease(patientId, owner, expiresAt);
      if (!stillOwned) this.logger.warn(`Lost lease on patient ${patientId}; version guard will arbitrate`);
      await this.events.extendLease(batch.map((event) => event._id), expiresAt);
    } catch (error) {
      this.logger.warn(`Heartbeat failed for patient ${patientId}: ${errorMessage(error)}`);
    }
  }
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
