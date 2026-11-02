import { PatientState } from '../domain';

export interface PatientLease {
  owner: string;
  expiresAt: Date;
}

/**
 * Derived data only: `state` can always be rebuilt by folding the patient's processed events.
 * `lease` and `version` are coordination metadata for the worker, not clinical facts.
 */
export interface PatientDocument {
  _id: string;
  state: PatientState;
  version: number;
  lease: PatientLease | null;
}
