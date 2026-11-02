import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import appConfig, { AppConfig } from '../config/app.config';
import { EventsRepository } from '../events/events.repository';
import { leaseExpiry } from './lease';
import { PatientProcessor } from './patient-processor';
import { PatientsRepository } from './patients.repository';

/**
 * One poll loop feeding a bounded number of slots. Slots are not threads: the work is I/O-bound,
 * so "a slot" is just an in-flight patient batch, and a single claim query refills all free ones.
 */
@Injectable()
export class WorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WorkerService.name);
  private readonly workerId = randomUUID();
  private readonly inFlight = new Map<string, Promise<void>>();
  private stopping = false;
  private loop?: Promise<void>;

  constructor(
    private readonly events: EventsRepository,
    private readonly patients: PatientsRepository,
    private readonly processor: PatientProcessor,
    @Inject(appConfig.KEY) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.pollLoop();
  }

  /** Graceful shutdown: stop taking work, let started batches finish. Anything cut short is the reaper's. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loop;
    await Promise.allSettled(this.inFlight.values());
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.claimIntoFreeSlots();
      } catch (error) {
        this.logger.error(`Claim cycle failed: ${error instanceof Error ? error.message : error}`);
      }
      await sleep(this.config.pollIntervalMs);
    }
  }

  private async claimIntoFreeSlots(): Promise<void> {
    const freeSlots = this.config.workerSlots - this.inFlight.size;
    if (freeSlots <= 0) return;

    // Skipping patients we are already processing avoids pointless claim attempts that would fail.
    const candidates = await this.events.findPatientsWithDueEvents([...this.inFlight.keys()], freeSlots);
    const claims = await Promise.all(
      candidates.map((patientId) =>
        this.patients.tryClaim(patientId, this.workerId, leaseExpiry(this.config.leaseMs)),
      ),
    );

    for (const patient of claims) {
      if (patient) this.dispatch(patient._id);
    }
  }

  private dispatch(patientId: string): void {
    const run = this.processor
      .process({ patientId, owner: this.workerId })
      .catch((error) =>
        // Events stay `processing` with a lease; the reaper returns them to `pending` on expiry.
        this.logger.error(`Batch for patient ${patientId} failed: ${error instanceof Error ? error.message : error}`),
      )
      .finally(() => this.inFlight.delete(patientId));
    this.inFlight.set(patientId, run);
  }
}
