import { Injectable } from '@nestjs/common';
import { EventStatus } from './event.document';
import { parseEventPayload } from './event-payload';
import { EventsRepository } from './events.repository';

export type IngestResult =
  | { accepted: true; id: string }
  | { accepted: false; id: string; errors: string[] };

@Injectable()
export class EventsService {
  constructor(private readonly events: EventsRepository) {}

  async ingest(body: unknown): Promise<IngestResult> {
    const parsed = await parseEventPayload(body);
    if (!parsed.valid) {
      const id = await this.events.insertInvalid(body, parsed.errors);
      return { accepted: false, id: id.toHexString(), errors: parsed.errors };
    }
    const id = await this.events.insertPending(parsed.event);
    return { accepted: true, id: id.toHexString() };
  }

  stats(): Promise<Record<EventStatus, number>> {
    return this.events.countByStatus();
  }
}
