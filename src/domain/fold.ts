import { applyEvent } from './apply-event';
import { DomainEvent, emptyPatientState, PatientState } from './patient-state';

const byTimestampThenId = (a: DomainEvent, b: DomainEvent): number =>
  a.ts.getTime() - b.ts.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Recomputes a patient's state from scratch. Sorting happens here, not in the caller, so the
 * result is the same for any input order — that is the convergence guarantee the tests pin down.
 */
export const foldPatientState = (events: readonly DomainEvent[]): PatientState =>
  [...events].sort(byTimestampThenId).reduce(applyEvent, emptyPatientState());
