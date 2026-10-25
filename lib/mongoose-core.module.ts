import {
  DynamicModule,
  Global,
  Module,
  OnApplicationShutdown,
  Provider,
  Type,
} from '@nestjs/common';
import * as mongoose from 'mongoose';
import { ConnectOptions, Connection } from 'mongoose';
import { defer, lastValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { getConnectionToken, handleRetry } from './common/mongoose.utils.js';
import {
  MongooseModuleAsyncOptions,
  MongooseModuleFactoryOptions,
  MongooseModuleOptions,
  MongooseOptionsFactory,
} from './interfaces/mongoose-options.interface.js';
import {
  MONGOOSE_CONNECTION_NAME,
  MONGOOSE_MODULE_OPTIONS,
} from './mongoose.constants.js';

@Global()
@Module({})
export class MongooseCoreModule implements OnApplicationShutdown {
  private static connections = new Map<string, Promise<Connection>>();
  private static isShuttingDown = false;

  static forRoot(
    uri: string,
    options: MongooseModuleOptions = {} as MongooseModuleOptions,
  ): DynamicModule {
    const {
      tenantId: _tenantId,
      retryAttempts,
      retryDelay,
      connectionName,
      connectionFactory,
      connectionErrorFactory,
      lazyConnection,
      onConnectionCreate,
      verboseRetryLog,
      ...mongooseOptions
    } = options;

    const mongooseConnectionFactory =
      connectionFactory || ((connection) => connection);

    const mongooseConnectionError =
      connectionErrorFactory || ((error) => error);

    const mongooseConnectionName = getConnectionToken(connectionName);

    const mongooseConnectionNameProvider = {
      provide: MONGOOSE_CONNECTION_NAME,
      useValue: mongooseConnectionName,
    };

    const connectionProvider = {
      provide: mongooseConnectionName,
      useFactory: async (): Promise<any> =>
        await lastValueFrom(
          defer(async () =>
            mongooseConnectionFactory(
              await this.createMongooseConnection(uri, mongooseOptions, {
                lazyConnection,
                onConnectionCreate,
              }),
              mongooseConnectionName,
            ),
          ).pipe(
            handleRetry(retryAttempts, retryDelay, verboseRetryLog),
            catchError((error) => {
              throw mongooseConnectionError(error);
            }),
          ),
        ),
    };
    return {
      module: MongooseCoreModule,
      providers: [connectionProvider, mongooseConnectionNameProvider],
      exports: [connectionProvider],
    };
  }

  static forRootAsync(options: MongooseModuleAsyncOptions): DynamicModule {
    const mongooseConnectionName = getConnectionToken(options.connectionName);

    const mongooseConnectionNameProvider = {
      provide: MONGOOSE_CONNECTION_NAME,
      useValue: mongooseConnectionName,
    };

    const connectionProvider = {
      provide: mongooseConnectionName,
      useFactory: async (
        mongooseModuleOptions: MongooseModuleFactoryOptions,
      ): Promise<any> => {
        const {
          tenantId: _tenantId,
          retryAttempts,
          retryDelay,
          uri,
          connectionFactory,
          connectionErrorFactory,
          lazyConnection,
          onConnectionCreate,
          verboseRetryLog,
          ...mongooseOptions
        } = mongooseModuleOptions;

        const mongooseConnectionFactory =
          connectionFactory || ((connection) => connection);

        const mongooseConnectionError =
          connectionErrorFactory || ((error) => error);

        return await lastValueFrom(
          defer(async () =>
            mongooseConnectionFactory(
              await this.createMongooseConnection(
                uri as string,
                mongooseOptions,
                { lazyConnection, onConnectionCreate },
              ),
              mongooseConnectionName,
            ),
          ).pipe(
            handleRetry(retryAttempts, retryDelay, verboseRetryLog),
            catchError((error) => {
              throw mongooseConnectionError(error);
            }),
          ),
        );
      },
      inject: [MONGOOSE_MODULE_OPTIONS],
    };
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: MongooseCoreModule,
      imports: options.imports,
      providers: [
        ...asyncProviders,
        connectionProvider,
        mongooseConnectionNameProvider,
      ],
      exports: [connectionProvider],
    };
  }

  private static createAsyncProviders(
    options: MongooseModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<MongooseOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: MongooseModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: MONGOOSE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    // `as Type<MongooseOptionsFactory>` is a workaround for microsoft/TypeScript#31603
    const inject = [
      (options.useClass || options.useExisting) as Type<MongooseOptionsFactory>,
    ];
    return {
      provide: MONGOOSE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: MongooseOptionsFactory) =>
        await optionsFactory.createMongooseOptions(),
      inject,
    };
  }

  private static async createMongooseConnection(
    uri: string,
    mongooseOptions: ConnectOptions,
    factoryOptions: {
      lazyConnection?: boolean;
      onConnectionCreate?: MongooseModuleOptions['onConnectionCreate'];
    },
  ): Promise<Connection> {
    if (this.isShuttingDown) {
      throw new Error(
        'MongooseCoreModule is shutting down. Cannot create new database connections.',
      );
    }

    const key = JSON.stringify([uri, mongooseOptions.dbName ?? null]);
    const cached = this.connections.get(key);
    if (cached) {
      const connection = await cached;
      return factoryOptions.lazyConnection
        ? connection
        : await connection.asPromise();
    }

    // Cache before creation starts, so concurrent calls share the same promise.
    const pending = Promise.resolve().then(async () => {
      const connection = mongoose.createConnection(uri, mongooseOptions);
      try {
        factoryOptions.onConnectionCreate?.(connection);
        if (factoryOptions.lazyConnection) {
          // Initial connection errors occur after a lazy provider has returned.
          void connection.asPromise().catch(async () => {
            if (this.connections.get(key) !== pending) return;
            this.connections.delete(key);
            await connection.close().catch(() => undefined);
          });
          return connection;
        }
        return await connection.asPromise();
      } catch (error) {
        await connection.close().catch(() => undefined);
        throw error;
      }
    });
    this.connections.set(key, pending);

    try {
      return await pending;
    } catch (error) {
      if (this.connections.get(key) === pending) this.connections.delete(key);
      throw error;
    }
  }

  async onApplicationShutdown() {
    MongooseCoreModule.isShuttingDown = true;
    try {
      const pending = [...MongooseCoreModule.connections.values()];
      // Take ownership before waiting; other module hooks will see an empty cache.
      MongooseCoreModule.connections.clear();
      const results = await Promise.allSettled(
        pending.map(async (promise) => {
          // Failed creation already cleans up its own connection.
          const connection = await promise.catch(() => undefined);
          if (connection) await connection.close();
        }),
      );
      const errors = results.filter((result) => result.status === 'rejected');
      if (errors.length) {
        throw new AggregateError(
          errors.map((result) => result.reason),
          'Failed to close Mongoose connections',
        );
      }
    } finally {
      MongooseCoreModule.isShuttingDown = false;
    }
  }
}
