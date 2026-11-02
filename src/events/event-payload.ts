import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventDto } from './dto/create-event.dto';
import { NewEvent } from './event.document';

export type ParsedPayload =
  | { valid: true; event: NewEvent }
  | { valid: false; errors: string[] };

/**
 * Validation never throws: a malformed payload is a result the caller stores, not an error to
 * bubble up, because rejecting it would drop clinical data.
 */
export async function parseEventPayload(body: unknown): Promise<ParsedPayload> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { valid: false, errors: ['body must be a JSON object'] };
  }

  const dto = plainToInstance(CreateEventDto, body);
  const violations = await validate(dto);
  if (violations.length > 0) {
    const errors = violations.flatMap((v) => Object.values(v.constraints ?? {}));
    return { valid: false, errors };
  }

  return {
    valid: true,
    event: { patientId: dto.patientId, type: dto.type, data: dto.data, ts: new Date(dto.ts) },
  };
}
