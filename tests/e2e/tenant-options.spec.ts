import { afterEach, describe, expect, it, vi } from 'vitest';
import { FactoryProvider } from '@nestjs/common';
import * as mongoose from 'mongoose';
import { MongooseCoreModule } from '../../lib/mongoose-core.module.js';
import { MongooseConnectionManager } from '../../lib/mongoose-connection-manager.js';
import { tenantIdConnection } from '../../lib/mongoose.constants.js';

vi.mock('mongoose', () => ({ createConnection: vi.fn() }));

describe('tenant connection options', () => {
  afterEach(() => {
    tenantIdConnection.clear();
    vi.clearAllMocks();
  });

  it.each(['sync', 'async'] as const)(
    'does not forward tenantId to the driver for %s registration',
    async (mode) => {
      const connection = { asPromise: vi.fn() };
      connection.asPromise.mockResolvedValue(connection);
      vi.mocked(mongoose.createConnection).mockReturnValue(connection as any);
      const options = { tenantId: 'tenant-a', maxPoolSize: 3 };
      const module =
        mode === 'sync'
          ? MongooseCoreModule.forRoot('mongodb://localhost/test', options)
          : MongooseCoreModule.forRootAsync({
              useFactory: () => ({
                ...options,
                uri: 'mongodb://localhost/test',
              }),
            });
      const provider = module.providers!.find(
        (p) =>
          typeof p === 'object' &&
          'provide' in p &&
          p.provide === 'DatabaseConnection',
      ) as FactoryProvider;
      const manager = new MongooseConnectionManager();
      const result =
        mode === 'sync'
          ? await provider.useFactory(manager)
          : await provider.useFactory(
              { ...options, uri: 'mongodb://localhost/test' },
              manager,
            );
      expect(result).toBe(connection);
      expect(mongoose.createConnection).toHaveBeenCalledExactlyOnceWith(
        'mongodb://localhost/test',
        { maxPoolSize: 3 },
      );
      if (mode === 'async') {
        expect(
          tenantIdConnection.get(
            JSON.stringify(['tenant-a', 'DatabaseConnection']),
          )?.connection,
        ).toBe(connection);
      }
    },
  );
});
