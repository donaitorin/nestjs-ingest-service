export type PatientStatus = 'admitted' | 'under_observation' | 'stable' | 'discharged';

export interface DomainEvent {
  /** Stable, totally ordered tie-breaker for events sharing the same `ts`. */
  id: string;
  type: string;
  data: unknown;
  ts: Date;
}

export interface Vitals {
  heartRate?: number;
  bloodPressure?: { systolic: number; diastolic: number };
  temperature?: number;
}

export interface Medication {
  name: string;
  dosageMg: number;
  frequency: string;
  active: boolean;
  adjustments: number;
}

export interface PatientState {
  vitals: Vitals;
  /** Kept as a name-sorted array: names are sender-controlled and make unsafe object keys. */
  medications: Medication[];
  admission: { status: PatientStatus; ward: string } | null;
}

export const emptyPatientState = (): PatientState => ({
  vitals: {},
  medications: [],
  admission: null,
});
