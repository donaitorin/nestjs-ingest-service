import { Body, Controller, Get, HttpCode, HttpStatus, Post, UnprocessableEntityException } from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  // The body is deliberately untyped: validation happens in the service so that malformed
  // payloads can be stored instead of being rejected by a pipe before we ever see them.
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(@Body() body: unknown): Promise<{ id: string }> {
    const result = await this.events.ingest(body);
    if (!result.accepted) {
      // Stored for audit, but the sender should know it will never be processed — and a 4xx
      // tells a well-behaved client to stop retrying.
      throw new UnprocessableEntityException({ id: result.id, errors: result.errors });
    }
    return { id: result.id };
  }

  @Get('stats')
  stats() {
    return this.events.stats();
  }
}
