import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextIdFactory, REQUEST } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import * as mongoose from 'mongoose';
import { MongooseModule } from '../../lib/mongoose.module.js';

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
        useFactory: (request: { uri?: string }) => ({
          uri: request.uri || 'mongodb://localhost/test',
        }),
      }),
    ],
  }).compile();
}

async function resolveRequest(app: TestingModule, uri?: string) {
  const context = ContextIdFactory.create();
  app.registerRequestByContextId({ uri }, context);
  return app.resolve<mongoose.Connection>('DatabaseConnection', context, {
    strict: false,
  });
}

describe('Mongoose connection pool sharing and lifecycle', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reuses connections for concurrent requests targeting the same URI and closes on shutdown', async () => {
    vi.mocked(mongoose.createConnection).mockImplementation(
      () => mockConnection() as any,
    );
    const app = await createApp();
    const connections = await Promise.all(
      Array.from({ length: 30 }, () =>
        resolveRequest(app, 'mongodb://localhost/shared_db'),
      ),
    );
    expect(new Set(connections).size).toBe(1);
    expect(mongoose.createConnection).toHaveBeenCalledTimes(1);

    await app.close();
    expect(connections[0].close).toHaveBeenCalledTimes(1);
  });

  it('creates separate connections for different URIs and closes all on shutdown', async () => {
    vi.mocked(mongoose.createConnection).mockImplementation(
      () => mockConnection() as any,
    );
    const app = await createApp();
    const first = await resolveRequest(app, 'mongodb://localhost/db1');
    const second = await resolveRequest(app, 'mongodb://localhost/db2');

    expect(first).not.toBe(second);
    expect(mongoose.createConnection).toHaveBeenCalledTimes(2);

    await app.close();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
  });
});
