import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import appConfig from '../../src/config/app.config';
import { DatabaseModule } from '../../src/database/database.module';
import { EventsModule } from '../../src/events/events.module';
import { ProcessingModule } from '../../src/processing/processing.module';
import { WorkerService } from '../../src/processing/worker.service';

export const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/?directConnection=true';

/**
 * A module wired to a throwaway database, so test files cannot see each other's data.
 * The background worker is stubbed out: tests drive the processor explicitly to stay deterministic.
 */
export async function createTestModule(): Promise<{ module: TestingModule; dbName: string }> {
  const dbName = `ingest_test_${randomUUID().replace(/-/g, '')}`;
  process.env.MONGO_DB = dbName;
  process.env.MONGO_URI = MONGO_URI;
  process.env.REAPER_INTERVAL_MS = '3600000';

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
      DatabaseModule,
      EventsModule,
      ProcessingModule,
    ],
  })
    .overrideProvider(WorkerService)
    .useValue({})
    .compile();

  return { module, dbName };
}

export async function dropDatabase(dbName: string): Promise<void> {
  const client = await MongoClient.connect(MONGO_URI);
  await client.db(dbName).dropDatabase();
  await client.close();
}
