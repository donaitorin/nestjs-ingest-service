import { Inject, Injectable } from '@nestjs/common';
import appConfig, { AppConfig } from '../config/app.config';
import { EventDocument } from '../events/event.document';
import { Semaphore } from './semaphore';

/**
 * Stands in for the slow external system. Only the timing is real.
 *
 * The semaphore lives here, not in the processor, because the limit protects the external API
 * as a whole — across every patient batch running in this process.
 */
@Injectable()
export class ExternalSystemClient {
  private readonly outbound: Semaphore;

  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {
    this.outbound = new Semaphore(config.maxOutboundConcurrency);
  }

  process(_event: EventDocument): Promise<void> {
    return this.outbound.run(async () => {
      await new Promise((resolve) => setTimeout(resolve, this.config.externalDelayMs));
      // Lets the load test exercise the partial-failure path without a real flaky dependency.
      if (Math.random() < this.config.externalFailureRate) {
        throw new Error('simulated external system failure');
      }
    });
  }
}
