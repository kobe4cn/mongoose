import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextIdFactory, REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as mongoose from 'mongoose';
import { MongooseModule } from '../../lib/mongoose.module.js';
import { MongooseConnectionManager } from '../../lib/mongoose-connection-manager.js';
import { tenantIdConnection } from '../../lib/mongoose.constants.js';

vi.mock('mongoose', () => ({ createConnection: vi.fn() }));

function mockConnection() {
  const connection = {
    close: vi.fn().mockResolvedValue(undefined),
    asPromise: vi.fn(),
  };
  connection.asPromise.mockResolvedValue(connection);
  return connection;
}

async function createApp() {
  return Test.createTestingModule({
    imports: [
      MongooseModule.forRootAsync({
        inject: [REQUEST],
        useFactory: (request: { tenantId?: string }) => ({
          tenantId: request.tenantId,
          uri: 'mongodb://localhost/test',
        }),
      }),
    ],
  }).compile();
}

async function resolveRequest(app: TestingModule, tenantId?: string) {
  const context = ContextIdFactory.create();
  app.registerRequestByContextId({ tenantId }, context);
  return app.resolve<mongoose.Connection>('DatabaseConnection', context, {
    strict: false,
  });
}

describe('request-scoped tenant connection lifecycle', () => {
  afterEach(() => {
    tenantIdConnection.clear();
    vi.clearAllMocks();
  });

  it('reuses concurrent requests and closes every tenant exactly once on shutdown', async () => {
    vi.mocked(mongoose.createConnection).mockImplementation(
      () => mockConnection() as any,
    );
    const app = await createApp();
    const connections = await Promise.all(
      Array.from({ length: 30 }, () => resolveRequest(app, 'a')),
    );
    const other = await resolveRequest(app, 'b');
    expect(new Set(connections).size).toBe(1);
    expect(mongoose.createConnection).toHaveBeenCalledTimes(2);
    expect(
      [...tenantIdConnection.values()].map((entry) => entry.owners.size),
    ).toEqual([1, 1]);
    expect(connections[0].close).not.toHaveBeenCalled();
    await app.close();
    expect(connections[0].close).toHaveBeenCalledTimes(1);
    expect(other.close).toHaveBeenCalledTimes(1);
    expect(tenantIdConnection.size).toBe(0);
  });

  it('keeps shared connections open until the last application closes', async () => {
    vi.mocked(mongoose.createConnection).mockImplementation(
      () => mockConnection() as any,
    );
    const first = await createApp();
    const second = await createApp();
    const shared = await resolveRequest(first, 'shared');
    expect(await resolveRequest(second, 'shared')).toBe(shared);
    const other = await resolveRequest(first, 'first-only');
    await first.close();
    expect(shared.close).not.toHaveBeenCalled();
    expect(other.close).toHaveBeenCalledTimes(1);
    expect([...tenantIdConnection.values()][0].owners.size).toBe(1);
    await second.close();
    expect(shared.close).toHaveBeenCalledTimes(1);
    expect(tenantIdConnection.size).toBe(0);
  });

  it('closes uncached request connections without resolving scoped providers at shutdown', async () => {
    vi.mocked(mongoose.createConnection).mockImplementation(
      () => mockConnection() as any,
    );
    const app = await createApp();
    const first = await resolveRequest(app);
    const second = await resolveRequest(app);
    expect(first).not.toBe(second);
    await app.close();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it.each(['sync', 'async'] as const)(
    'closes singleton %s connections once',
    async (mode) => {
      const connection = mockConnection();
      vi.mocked(mongoose.createConnection).mockReturnValue(connection as any);
      const options = { uri: 'mongodb://localhost/test' };
      const app = await Test.createTestingModule({
        imports: [
          mode === 'sync'
            ? MongooseModule.forRoot(options.uri)
            : MongooseModule.forRootAsync({ useFactory: () => options }),
        ],
      }).compile();
      expect(app.get('DatabaseConnection')).toBe(connection);
      await app.close();
      expect(connection.close).toHaveBeenCalledTimes(1);
    },
  );

  it('can shut down before any request has created a connection', async () => {
    const app = await createApp();
    await app.close();
    expect(mongoose.createConnection).not.toHaveBeenCalled();
  });
});

describe('connection manager cleanup', () => {
  afterEach(() => tenantIdConnection.clear());

  it('removes failed creation and permits a fresh attempt', async () => {
    const manager = new MongooseConnectionManager();
    const connection = mockConnection();
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('creation failed'))
      .mockResolvedValue(connection);
    await expect(manager.acquire('a', create)).rejects.toThrow(
      'creation failed',
    );
    expect(tenantIdConnection.size).toBe(0);
    expect(await manager.acquire('a', create)).toBe(connection);
    await manager.onApplicationShutdown();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  it('waits for pending creation and makes repeated shutdown idempotent', async () => {
    const manager = new MongooseConnectionManager();
    const connection = mockConnection();
    let finish!: (value: mongoose.Connection) => void;
    const pending = manager.acquire(
      'a',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    const shutdown = manager.onApplicationShutdown();
    expect(manager.onApplicationShutdown()).toBe(shutdown);
    await expect(
      manager.acquire('b', async () => connection as any),
    ).rejects.toThrow('shutting down');
    finish(connection as any);
    await pending;
    await shutdown;
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(tenantIdConnection.size).toBe(0);
  });

  it('attempts all closes even if one connection fails to close', async () => {
    const manager = new MongooseConnectionManager();
    const first = mockConnection();
    const second = mockConnection();
    first.close.mockRejectedValue(new Error('close failed'));
    await manager.acquire('a', async () => first as any);
    await manager.acquire('b', async () => second as any);
    await expect(manager.onApplicationShutdown()).rejects.toThrow(
      'Failed to close',
    );
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(tenantIdConnection.size).toBe(0);
  });
});
