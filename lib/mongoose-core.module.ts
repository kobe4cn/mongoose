import { DynamicModule, Global, Module, Provider, Type } from '@nestjs/common';
import * as mongoose from 'mongoose';
import { ConnectOptions, Connection } from 'mongoose';
import { defer, lastValueFrom } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { getConnectionToken, handleRetry } from './common/mongoose.utils.js';
import { MongooseConnectionManager } from './mongoose-connection-manager.js';
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
export class MongooseCoreModule {
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
      useFactory: async (manager: MongooseConnectionManager): Promise<any> =>
        await lastValueFrom(
          defer(() =>
            manager.acquire(undefined, async () =>
              mongooseConnectionFactory(
                await this.createMongooseConnection(uri, mongooseOptions, {
                  lazyConnection,
                  onConnectionCreate,
                }),
                mongooseConnectionName,
              ),
            ),
          ).pipe(
            handleRetry(retryAttempts, retryDelay, verboseRetryLog),
            catchError((error) => {
              throw mongooseConnectionError(error);
            }),
          ),
        ),
      inject: [MongooseConnectionManager],
    };
    return {
      module: MongooseCoreModule,
      providers: [
        connectionProvider,
        mongooseConnectionNameProvider,
        MongooseConnectionManager,
      ],
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
        manager: MongooseConnectionManager,
      ): Promise<any> => {
        const {
          tenantId,
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

        // 同一个缓存键必须始终对应相同的数据库配置。
        const cacheKey =
          tenantId === undefined
            ? undefined
            : JSON.stringify([tenantId, mongooseConnectionName]);

        const mongooseConnectionFactory =
          connectionFactory || ((connection) => connection);

        const mongooseConnectionError =
          connectionErrorFactory || ((error) => error);

        //创建连接
        const createConnection = async (): Promise<Connection> => {
          const connection = await this.createMongooseConnection(
            uri as string,
            mongooseOptions,
            { lazyConnection, onConnectionCreate },
          );

          try {
            return await mongooseConnectionFactory(
              connection,
              mongooseConnectionName,
            );
          } catch (error) {
            // factory 失败时，释放本次已经创建的连接，
            // 保留原始错误交给外层重试。
            await connection.close().catch(() => undefined);
            throw error;
          }
        };

        return await lastValueFrom(
          defer(() => manager.acquire(cacheKey, createConnection)).pipe(
            handleRetry(retryAttempts, retryDelay, verboseRetryLog),
            catchError((error) => {
              throw mongooseConnectionError(error);
            }),
          ),
        );
      },
      inject: [MONGOOSE_MODULE_OPTIONS, MongooseConnectionManager],
    };
    const asyncProviders = this.createAsyncProviders(options);
    return {
      module: MongooseCoreModule,
      imports: options.imports,
      providers: [
        ...asyncProviders,
        MongooseConnectionManager,
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
    const connection = mongoose.createConnection(uri, mongooseOptions);

    factoryOptions?.onConnectionCreate?.(connection);

    if (factoryOptions?.lazyConnection) {
      return connection;
    }

    return await connection.asPromise();
  }
}
