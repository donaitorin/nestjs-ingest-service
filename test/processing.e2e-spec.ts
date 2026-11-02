import { TestingModule } from '@nestjs/testing';
import { Collection, MongoClient, ObjectId } from 'mongodb';
import { EventDocument } from '../src/events/event.document';
import { EventsRepository } from '../src/events/events.repository';
import { ExternalSystemClient } from '../src/processing/external-system.client';
import { PatientProcessor } from '../src/processing/patient-processor';
import { PatientsRepository } from '../src/processing/patients.repository';
import { ReaperService } from '../src/processing/reaper.service';
import { createTestModule, dropDatabase, MONGO_URI } from './support/test-module';

describe('processing', () => {
  let module: TestingModule;
  let dbName: string;
  let events: EventsRepository;
  let patients: PatientsRepository;
  let processor: PatientProcessor;
  let reaper: ReaperService;
  let client: MongoClient;
  let rawEvents: Collection;
  let rawPatients: Collection<{ _id: string }>;
  const external = { process: jest.fn<Promise<void>, [EventDocument]>() };

  beforeAll(async () => {
    process.env.RETRY_BASE_DELAY_MS = '60000';
    process.env.EXTERNAL_DELAY_MS = '0';
    const created = await createTestModule();
    module = created.module;
    dbName = created.dbName;
    // The stub replaces the sleep with something the tests can make succeed or fail per event.
    module.get(ExternalSystemClient).process = external.process;
    await module.init();
    events = module.get(EventsRepository);
    patients = module.get(PatientsRepository);
    processor = module.get(PatientProcessor);
    reaper = module.get(ReaperService);
    client = await MongoClient.connect(MONGO_URI);
    rawEvents = client.db(dbName).collection('events');
    rawPatients = client.db(dbName).collection('patients');
  });

  afterAll(async () => {
    await client.close();
    await module.close();
    await dropDatabase(dbName);
  });

  beforeEach(() => external.process.mockReset().mockResolvedValue());

  const ago = (ms: number) => new Date(Date.now() - ms);
  const inFuture = (ms: number) => new Date(Date.now() + ms);
  const vitals = (patientId: string, ts: string, heartRate: number) => ({
    patientId,
    type: 'vitals.recorded',
    data: { heartRate },
    ts: new Date(ts),
  });
  const claim = async (patientId: string, owner = 'worker-1') => {
    const patient = await patients.tryClaim(patientId, owner, inFuture(30_000));
    expect(patient).not.toBeNull();
    return { patientId, owner };
  };

  it('folds late-arriving events into the right position', async () => {
    await events.insertPending(vitals('p-order', '2024-01-01T12:00:00Z', 90));
    await processor.process(await claim('p-order'));
    expect((await patients.get('p-order'))?.state.vitals.heartRate).toBe(90);

    // Created earlier than what was already applied, but arrives afterwards.
    await events.insertPending(vitals('p-order', '2024-01-01T08:00:00Z', 60));
    await processor.process(await claim('p-order'));

    const patient = await patients.get('p-order');
    expect(patient?.state.vitals.heartRate).toBe(90);
    expect(patient?.version).toBe(2);
    expect((await events.findProcessed('p-order')).length).toBe(2);
  });

  it('does not let a second worker claim a live lease, but does after it expires', async () => {
    expect(await patients.tryClaim('p-lease', 'worker-a', ago(1))).not.toBeNull();
    // worker-a's lease is already in the past, so worker-b may take over.
    expect(await patients.tryClaim('p-lease', 'worker-b', inFuture(30_000))).toMatchObject({
      lease: { owner: 'worker-b' },
    });
    expect(await patients.tryClaim('p-lease', 'worker-c', inFuture(30_000))).toBeNull();
  });

  it('reclaims work abandoned by a crashed worker and processes it exactly once', async () => {
    await events.insertPending(vitals('p-crash', '2024-02-01T10:00:00Z', 75));
    // The dead worker: claims the patient and the events, then vanishes without renewing.
    await patients.tryClaim('p-crash', 'dead-worker', ago(1));
    await events.claimDueEvents('p-crash', 50, ago(1));
    expect(await events.countByStatus()).toMatchObject({ processing: 1 });

    expect(await reaper.reap()).toBe(1);
    await processor.process(await claim('p-crash', 'worker-2'));

    const [processed] = await events.findProcessed('p-crash');
    expect(processed.attempts).toBe(1);
    expect((await patients.get('p-crash'))?.state.vitals.heartRate).toBe(75);
  });

  it('marks an event failed instead of looping when it keeps killing its worker', async () => {
    const id = await events.insertPending(vitals('p-poison', '2024-02-02T10:00:00Z', 1));
    const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 5);
    for (let i = 0; i < maxAttempts; i++) {
      await events.claimDueEvents('p-poison', 50, ago(1));
      await reaper.reap();
    }
    const stored = await rawEvents.findOne({ _id: id });
    expect(stored?.status).toBe('failed');
  });

  it('handles a partial batch failure: successes proceed, the failure is retried with backoff', async () => {
    const good1 = await events.insertPending(vitals('p-partial', '2024-03-01T10:00:00Z', 70));
    const bad = await events.insertPending(vitals('p-partial', '2024-03-01T11:00:00Z', 99));
    const good2 = await events.insertPending(vitals('p-partial', '2024-03-01T12:00:00Z', 80));
    external.process.mockImplementation(async (event) => {
      if (event._id.equals(bad)) throw new Error('external timeout');
    });

    await processor.process(await claim('p-partial'));

    const byId = async (id: ObjectId) => rawEvents.findOne({ _id: id });
    expect(await byId(good1)).toMatchObject({ status: 'processed' });
    expect(await byId(good2)).toMatchObject({ status: 'processed' });
    const failed = await byId(bad);
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: 'external timeout' });
    expect(failed!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // State reflects only what succeeded; the 99 is not counted.
    expect((await patients.get('p-partial'))?.state.vitals.heartRate).toBe(80);
  });

  it('gives up with status failed once attempts are exhausted', async () => {
    const id = await events.insertPending(vitals('p-exhaust', '2024-04-01T10:00:00Z', 70));
    external.process.mockRejectedValue(new Error('always down'));
    const maxAttempts = Number(process.env.MAX_ATTEMPTS ?? 5);

    for (let i = 0; i < maxAttempts; i++) {
      await rawEvents.updateOne({ _id: id }, { $set: { nextAttemptAt: ago(1) } }); // skip the backoff wait
      await processor.process(await claim('p-exhaust'));
    }

    expect(await rawEvents.findOne({ _id: id })).toMatchObject({
      status: 'failed',
      attempts: maxAttempts,
      lastError: 'always down',
    });
  });

  it('rebuilds identical patient state by re-folding events after the patients doc is lost', async () => {
    await events.insertPending(vitals('p-rebuild', '2024-06-01T10:00:00Z', 66));
    await processor.process(await claim('p-rebuild'));
    const before = (await patients.get('p-rebuild'))!.state;

    await rawPatients.deleteOne({ _id: 'p-rebuild' });
    await events.insertPending({ ...vitals('p-rebuild', '2024-06-01T09:00:00Z', 50), type: 'unknown.type' });
    await processor.process(await claim('p-rebuild'));

    expect((await patients.get('p-rebuild'))!.state).toEqual(before);
  });
});
