import { foldPatientState } from './fold';
import { DomainEvent } from './patient-state';

let seq = 0;
const event = (type: string, data: unknown, ts: string): DomainEvent => ({
  id: String(++seq).padStart(24, '0'),
  type,
  data,
  ts: new Date(ts),
});

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

const med = (action: string, dosageMg: number, ts: string) =>
  event('medication.changed', { medication: 'metformin', dosageMg, frequency: 'daily', action }, ts);
const status = (value: string, ts: string) =>
  event('status.changed', { status: value, ward: 'cardiology' }, ts);

const events = [
  status('admitted', '2024-01-01T08:00:00Z'),
  med('started', 500, '2024-01-01T09:00:00Z'),
  event('vitals.recorded', { heartRate: 70, temperature: 36.5 }, '2024-01-01T10:00:00Z'),
  med('adjusted', 1000, '2024-01-01T11:00:00Z'),
  event('vitals.recorded', { heartRate: 82 }, '2024-01-01T12:00:00Z'),
  status('stable', '2024-01-01T13:00:00Z'),
];

describe('foldPatientState', () => {
  it('converges: every arrival order yields the same state', () => {
    const expected = foldPatientState(events);
    for (const order of permutations(events)) {
      expect(foldPatientState(order)).toEqual(expected);
    }
  });

  it('is idempotent: folding the same events twice yields identical output', () => {
    expect(foldPatientState(events)).toEqual(foldPatientState(events));
  });

  it('does not mutate its input', () => {
    const input = [...events].reverse();
    const snapshot = structuredClone(input);
    foldPatientState(input);
    expect(input).toEqual(snapshot);
  });

  it('applies the expected state for the ordered stream', () => {
    expect(foldPatientState(events)).toEqual({
      vitals: { heartRate: 82, temperature: 36.5 },
      medications: [
        { name: 'metformin', dosageMg: 1000, frequency: 'daily', active: true, adjustments: 1 },
      ],
      admission: { status: 'stable', ward: 'cardiology' },
    });
  });

  it('lets order decide the outcome: a late "started" lands before the later "adjusted"', () => {
    const adjustedFirst = [med('adjusted', 1000, '2024-01-01T11:00:00Z')];
    expect(foldPatientState(adjustedFirst).medications).toEqual([]);
    const withLateStart = [...adjustedFirst, med('started', 500, '2024-01-01T09:00:00Z')];
    expect(foldPatientState(withLateStart).medications[0].dosageMg).toBe(1000);
  });

  it('breaks ts ties by event id', () => {
    const a = event('vitals.recorded', { heartRate: 60 }, '2024-01-01T10:00:00Z');
    const b = event('vitals.recorded', { heartRate: 90 }, '2024-01-01T10:00:00Z');
    expect(foldPatientState([b, a]).vitals.heartRate).toBe(90);
  });

  it('rejects invalid status transitions', () => {
    const state = foldPatientState([
      status('discharged', '2024-01-01T08:00:00Z'),
      status('admitted', '2024-01-01T09:00:00Z'),
    ]);
    expect(state.admission?.status).toBe('admitted');
  });

  it('skips unknown types and malformed data instead of throwing', () => {
    const state = foldPatientState([
      event('something.new', { a: 1 }, '2024-01-01T08:00:00Z'),
      event('vitals.recorded', 'not-an-object', '2024-01-01T09:00:00Z'),
      event('medication.changed', { medication: 'x' }, '2024-01-01T10:00:00Z'),
      event('status.changed', { status: 'bogus', ward: 'w' }, '2024-01-01T11:00:00Z'),
    ]);
    expect(state).toEqual({ vitals: {}, medications: [], admission: null });
  });
});
