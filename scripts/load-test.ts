/**
 * Sustained-load generator. Sends events at a fixed rate with deliberate duplicates, out-of-order
 * timestamps and a few malformed payloads, then waits for the queue to drain and checks that
 * nothing was lost or double-stored.
 *
 *   npm run load-test
 *   EVENTS_PER_MIN=3000 DURATION_SEC=120 npm run load-test
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const EVENTS_PER_MIN = Number(process.env.EVENTS_PER_MIN ?? 1000);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 60);
const PATIENTS = Number(process.env.PATIENTS ?? 200);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE ?? 0.1);
const INVALID_RATE = Number(process.env.INVALID_RATE ?? 0.01);
const DRAIN_TIMEOUT_SEC = Number(process.env.DRAIN_TIMEOUT_SEC ?? 120);
const OUT_OF_ORDER_WINDOW_MS = 10 * 60_000;

type Payload = Record<string, unknown>;
type Stats = Record<'pending' | 'processing' | 'processed' | 'failed' | 'invalid', number>;

const pick = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildPayload(sequence: number): Payload {
  // A timestamp jittered backwards from "now" means later sends regularly carry earlier ts.
  const ts = new Date(Date.now() - Math.random() * OUT_OF_ORDER_WINDOW_MS + sequence).toISOString();
  const patientId = `patient-${Math.floor(Math.random() * PATIENTS)}`;
  const kind = Math.floor(Math.random() * 3);

  if (kind === 0) {
    return { patientId, type: 'vitals.recorded', ts, data: { heartRate: 50 + Math.floor(Math.random() * 60) } };
  }
  if (kind === 1) {
    const action = pick(['started', 'adjusted', 'stopped']);
    return {
      patientId, type: 'medication.changed', ts,
      data: { medication: 'metformin', dosageMg: pick([250, 500, 1000]), frequency: 'twice_daily', action },
    };
  }
  const status = pick(['admitted', 'under_observation', 'stable', 'discharged']);
  return { patientId, type: 'status.changed', ts, data: { status, ward: 'cardiology' } };
}

async function send(payload: Payload): Promise<number> {
  try {
    const response = await fetch(`${BASE_URL}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.status;
  } catch {
    return 0;
  }
}

async function getStats(): Promise<Stats> {
  const response = await fetch(`${BASE_URL}/events/stats`);
  return (await response.json()) as Stats;
}

const total = (stats: Stats) => Object.values(stats).reduce((sum, n) => sum + n, 0);

async function main(): Promise<void> {
  const intervalMs = 60_000 / EVENTS_PER_MIN;
  const totalToSend = Math.round((EVENTS_PER_MIN / 60) * DURATION_SEC);
  const baseline = total(await getStats());

  const sent: Payload[] = [];
  const uniqueKeys = new Set<string>();
  const statusCounts = new Map<number, number>();
  let invalidSent = 0;
  let duplicatesSent = 0;

  console.log(`Sending ~${totalToSend} events at ${EVENTS_PER_MIN}/min for ${DURATION_SEC}s`);
  const inFlight: Promise<void>[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < totalToSend; i++) {
    let payload: Payload;
    const roll = Math.random();
    if (roll < INVALID_RATE) {
      payload = { patientId: 'patient-bad', type: 'vitals.recorded', ts: 'not-a-date' };
      invalidSent++;
    } else if (roll < INVALID_RATE + DUPLICATE_RATE && sent.length > 0) {
      payload = pick(sent); // a sender retry: identical payload
      duplicatesSent++;
    } else {
      payload = buildPayload(i);
      sent.push(payload);
      uniqueKeys.add(`${payload.patientId}|${payload.type}|${payload.ts}`);
    }

    inFlight.push(send(payload).then((status) => void statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1)));

    if ((i + 1) % Math.round(EVENTS_PER_MIN / 6) === 0) console.log('stats:', await getStats());
    // Pace against the wall clock, not a fixed sleep, so request latency does not skew the rate.
    await sleep(Math.max(0, startedAt + (i + 1) * intervalMs - Date.now()));
  }
  await Promise.all(inFlight);
  console.log('HTTP status codes:', Object.fromEntries(statusCounts));

  console.log('Waiting for the queue to drain...');
  const deadline = Date.now() + DRAIN_TIMEOUT_SEC * 1000;
  let stats = await getStats();
  while ((stats.pending > 0 || stats.processing > 0) && Date.now() < deadline) {
    await sleep(2000);
    stats = await getStats();
    console.log('stats:', stats);
  }

  const expected = uniqueKeys.size + invalidSent;
  const stored = total(stats) - baseline;
  console.log(
    `\nsent ${totalToSend} (${duplicatesSent} duplicates, ${invalidSent} invalid) -> ` +
      `${uniqueKeys.size} unique valid + ${invalidSent} invalid = ${expected} expected documents`,
  );
  console.log(`stored ${stored} new documents; processed=${stats.processed} failed=${stats.failed}`);

  const drained = stats.pending === 0 && stats.processing === 0;
  const ok = drained && stored === expected && stats.failed === 0;
  console.log(ok ? 'OK: nothing lost, nothing double-stored' : 'MISMATCH: investigate');
  process.exit(ok ? 0 : 1);
}

void main();
