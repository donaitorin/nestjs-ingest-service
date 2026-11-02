import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import appConfig, { AppConfig } from '../config/app.config';
import { EventsRepository } from '../events/events.repository';

/** Returns work abandoned by crashed workers (expired lease) to the queue. */
@Injectable()
export class ReaperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReaperService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly events: EventsRepository,
    @Inject(appConfig.KEY) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.reap(), this.config.reaperIntervalMs);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async reap(): Promise<number> {
    try {
      const released = await this.events.releaseExpired(this.config.maxAttempts);
      if (released > 0) this.logger.warn(`Returned ${released} abandoned event(s) to pending`);
      return released;
    } catch (error) {
      this.logger.error(`Reaper cycle failed: ${error instanceof Error ? error.message : error}`);
      return 0;
    }
  }
}
