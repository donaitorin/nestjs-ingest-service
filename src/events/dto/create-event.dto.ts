import { IsISO8601, IsNotEmpty, IsObject, IsString, Matches } from 'class-validator';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  patientId!: string;

  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsObject()
  data!: Record<string, unknown>;

  // The offset is mandatory: without one, `new Date()` would interpret the string in the
  // server's local timezone and the dedupe key would depend on where we happen to run.
  @IsISO8601({ strict: true })
  @Matches(/(Z|[+-]\d{2}:?\d{2})$/i, { message: 'ts must include a timezone designator' })
  ts!: string;
}
