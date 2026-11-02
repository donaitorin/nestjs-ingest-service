import { ConfigType, registerAs } from '@nestjs/config';

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
};

const appConfig = registerAs('app', () => {
  const config = {
    port: numberFromEnv('PORT', 3000),
    mongoUri: process.env.MONGO_URI ?? 'mongodb://localhost:27017/?directConnection=true',
    mongoDb: process.env.MONGO_DB ?? 'ingest',

    externalDelayMs: numberFromEnv('EXTERNAL_DELAY_MS', 5000),
    externalFailureRate: numberFromEnv('EXTERNAL_FAILURE_RATE', 0),
    maxOutboundConcurrency: numberFromEnv('MAX_OUTBOUND_CONCURRENCY', 200),

    workerSlots: numberFromEnv('WORKER_SLOTS', 100),
    maxBatch: numberFromEnv('MAX_BATCH', 50),
    pollIntervalMs: numberFromEnv('POLL_INTERVAL_MS', 150),
    leaseMs: numberFromEnv('LEASE_MS', 30_000),
    heartbeatMs: numberFromEnv('HEARTBEAT_MS', 10_000),
    reaperIntervalMs: numberFromEnv('REAPER_INTERVAL_MS', 5000),

    maxAttempts: numberFromEnv('MAX_ATTEMPTS', 5),
    retryBaseDelayMs: numberFromEnv('RETRY_BASE_DELAY_MS', 1000),
    maxFoldRetries: numberFromEnv('MAX_FOLD_RETRIES', 3),
  };

  // A heartbeat slower than half the lease risks losing the lease to one late tick.
  if (config.heartbeatMs * 2 > config.leaseMs) {
    throw new Error('HEARTBEAT_MS must be at most half of LEASE_MS');
  }
  return config;
});

export type AppConfig = ConfigType<typeof appConfig>;
export default appConfig;
