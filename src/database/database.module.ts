import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import appConfig, { AppConfig } from '../config/app.config';

export const MONGO_CLIENT = Symbol('MONGO_CLIENT');
export const MONGO_DB = Symbol('MONGO_DB');

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [appConfig.KEY],
      useFactory: (config: AppConfig) => MongoClient.connect(config.mongoUri),
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT, appConfig.KEY],
      useFactory: (client: MongoClient, config: AppConfig): Db => client.db(config.mongoDb),
    },
  ],
  exports: [MONGO_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  // Runs after every OnModuleDestroy hook, so in-flight batches can still reach Mongo while draining.
  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
  }
}
