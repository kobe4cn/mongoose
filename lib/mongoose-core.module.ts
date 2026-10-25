import {
  DynamicModule,
  Global,
  Inject,
  Module,
  OnApplicationShutdown,
  Provider,
  Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
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
  tenantIdConnection,
} from './mongoose.constants.js';

@Global()
@Module({})
export class MongooseCoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(MONGOOSE_CONNECTION_NAME) private readonly connectionName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  static forRoot(
    uri: string,
    options: MongooseModuleOptions = {} as MongooseModuleOptions,
  ): DynamicModule {
    const {
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
    // 没有指定 tenantId 时，不启用租户缓存。
    // 同一个缓存键必须始终对应相同的数据库配置。
    const cacheKey =
      options.tenantId === undefined
        ? undefined
        : JSON.stringify([options.tenantId, mongooseConnectionName]);

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
          defer(async () => {
            if (cacheKey === undefined) {
              return createConnection();
            }
            let entry = tenantIdConnection.get(cacheKey);
            if (!entry) {
              entry = {
                promise: createConnection(),
                users: 0,
              };
              tenantIdConnection.set(cacheKey, entry);
            }
            try {
              const connection = await entry.promise;
              entry.connection = connection;
              entry.users += 1;
              return connection;
            } catch (err) {
              //仅移除每次失败的条目
              if (tenantIdConnection.get(cacheKey) === entry) {
                tenantIdConnection.delete(cacheKey);
              }
              throw err;
            }
          }).pipe(
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
    mongoose.connections;
    const connection = mongoose.createConnection(uri, mongooseOptions);

    factoryOptions?.onConnectionCreate?.(connection);

    if (factoryOptions?.lazyConnection) {
      return connection;
    }

    return connection.asPromise();
  }
  private connectionReleased = false;
  async onApplicationShutdown() {
    if (this.connectionReleased) return;

    this.connectionReleased = true;

    const connection = this.moduleRef.get<any>(this.connectionName);

    if (!connection) {
      return;
    }
    for (const [key, entry] of tenantIdConnection) {
      if (entry.connection !== connection) {
        continue;
      }
      entry.users -= 1;
      if (entry.users === 0) {
        tenantIdConnection.delete(key);
        await connection.close();
      }
      return;
    }

    if (connection) {
      await connection.close();
    }
  }
}
