import { INestApplication } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import request from 'supertest';
import { createTestModule, dropDatabase, MONGO_URI } from './support/test-module';

describe('POST /events', () => {
  let app: INestApplication;
  let dbName: string;
  let client: MongoClient;

  beforeAll(async () => {
    const created = await createTestModule();
    dbName = created.dbName;
    app = created.module.createNestApplication();
    await app.init();
    client = await MongoClient.connect(MONGO_URI);
  });

  afterAll(async () => {
    await client.close();
    await app.close();
    await dropDatabase(dbName);
  });

  const events = () => client.db(dbName).collection('events');
  const payload = (overrides: object = {}) => ({
    patientId: 'p-dedupe',
    type: 'vitals.recorded',
    data: { heartRate: 70 },
    ts: '2024-05-01T10:00:00.000Z',
    ...overrides,
  });

  it('answers 202 with the event id and stores it as pending', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send(payload({ patientId: 'p-basic' }))
      .expect(202);

    const stored = await events().findOne({ patientId: 'p-basic' });
    expect(res.body.id).toBe(stored?._id.toHexString());
    expect(stored).toMatchObject({ status: 'pending', attempts: 0 });
    expect(stored?.ts).toBeInstanceOf(Date);
  });

  it('dedupes concurrent identical requests: one document, same id, same 202 for everyone', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, () => request(app.getHttpServer()).post('/events').send(payload())),
    );

    expect(responses.every((res) => res.status === 202)).toBe(true);
    expect(new Set(responses.map((res) => res.body.id)).size).toBe(1);
    expect(await events().countDocuments({ patientId: 'p-dedupe' })).toBe(1);
  });

  it('treats the same instant in a different timezone as a duplicate', async () => {
    const first = await request(app.getHttpServer())
      .post('/events')
      .send(payload({ patientId: 'p-tz', ts: '2024-05-01T10:00:00Z' }))
      .expect(202);
    const second = await request(app.getHttpServer())
      .post('/events')
      .send(payload({ patientId: 'p-tz', ts: '2024-05-01T12:00:00+02:00' }))
      .expect(202);

    expect(second.body.id).toBe(first.body.id);
    expect(await events().countDocuments({ patientId: 'p-tz' })).toBe(1);
  });

  it('stores invalid payloads instead of dropping them, and tells the sender', async () => {
    const res = await request(app.getHttpServer())
      .post('/events')
      .send({ patientId: 'p-bad', type: 'vitals.recorded', ts: 'yesterday' })
      .expect(422);

    const stored = await events().findOne({ status: 'invalid' });
    expect(res.body.id).toBe(stored?._id.toHexString());
    expect(stored?.raw).toMatchObject({ patientId: 'p-bad' });
    expect(stored?.validationErrors.length).toBeGreaterThan(0);
  });

  it('keeps several invalid payloads without colliding on the dedupe index', async () => {
    await request(app.getHttpServer()).post('/events').send({ nonsense: 1 }).expect(422);
    await request(app.getHttpServer()).post('/events').send({ nonsense: 2 }).expect(422);
    expect(await events().countDocuments({ status: 'invalid' })).toBeGreaterThanOrEqual(3);
  });

  it('reports counts per status', async () => {
    const res = await request(app.getHttpServer()).get('/events/stats').expect(200);
    expect(res.body).toMatchObject({ pending: expect.any(Number), invalid: expect.any(Number) });
    expect(res.body.processing).toBe(0);
  });
});
