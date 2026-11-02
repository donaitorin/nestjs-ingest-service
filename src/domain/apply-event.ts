import { DomainEvent, Medication, PatientState, PatientStatus } from './patient-state';

type Data = Record<string, unknown>;

const isRecord = (value: unknown): value is Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';

// A state machine, so that applying the same events in a different order can yield a different
// (or rejected) outcome: "discharged" before "admitted" is meaningless.
const ALLOWED_TRANSITIONS: Record<PatientStatus | 'none', readonly PatientStatus[]> = {
  none: ['admitted'],
  admitted: ['under_observation', 'stable'],
  under_observation: ['stable', 'admitted'],
  stable: ['under_observation', 'discharged'],
  discharged: [],
};

const isPatientStatus = (value: unknown): value is PatientStatus =>
  typeof value === 'string' && value in ALLOWED_TRANSITIONS && value !== 'none';

/**
 * Pure: the result depends only on the arguments. No clock, no randomness, no persisted state.
 * That purity is what makes reprocessing and late arrivals safe — replaying the same events
 * through this function always lands on the same state.
 *
 * Events that do not make sense for the current state (or are malformed, or of an unknown
 * type) are skipped rather than thrown on: one bad event must not block a patient's stream.
 */
export function applyEvent(state: PatientState, event: DomainEvent): PatientState {
  if (!isRecord(event.data)) return state;

  switch (event.type) {
    case 'vitals.recorded':
      return applyVitals(state, event.data);
    case 'medication.changed':
      return applyMedication(state, event.data);
    case 'status.changed':
      return applyStatus(state, event.data);
    default:
      return state;
  }
}

// Last write wins, per field: a reading that omits a field must not erase the previous one.
function applyVitals(state: PatientState, data: Data): PatientState {
  const { heartRate, bloodPressure, temperature } = data;
  const vitals = { ...state.vitals };

  if (isNumber(heartRate)) vitals.heartRate = heartRate;
  if (isNumber(temperature)) vitals.temperature = temperature;
  if (
    isRecord(bloodPressure) &&
    isNumber(bloodPressure.systolic) &&
    isNumber(bloodPressure.diastolic)
  ) {
    vitals.bloodPressure = {
      systolic: bloodPressure.systolic,
      diastolic: bloodPressure.diastolic,
    };
  }
  return { ...state, vitals };
}

// "adjusted" and "stopped" only mean something after "started", so the order decides the dosage.
function applyMedication(state: PatientState, data: Data): PatientState {
  const { medication, dosageMg, frequency, action } = data;
  if (!isString(medication) || !isNumber(dosageMg) || !isString(frequency)) return state;

  const current = state.medications.find((m) => m.name === medication);
  let next: Medication;

  switch (action) {
    case 'started':
      next = { name: medication, dosageMg, frequency, active: true, adjustments: 0 };
      break;
    case 'adjusted':
      if (!current?.active) return state;
      next = { ...current, dosageMg, frequency, adjustments: current.adjustments + 1 };
      break;
    case 'stopped':
      if (!current) return state;
      next = { ...current, active: false };
      break;
    default:
      return state;
  }

  const others = state.medications.filter((m) => m.name !== medication);
  const medications = [...others, next].sort((a, b) => a.name.localeCompare(b.name));
  return { ...state, medications };
}

function applyStatus(state: PatientState, data: Data): PatientState {
  const { status, ward } = data;
  if (!isPatientStatus(status) || !isString(ward)) return state;

  const from = state.admission?.status ?? 'none';
  if (!ALLOWED_TRANSITIONS[from].includes(status)) return state;
  return { ...state, admission: { status, ward } };
}
