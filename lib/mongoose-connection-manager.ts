import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Connection } from 'mongoose';
import {
  TenantConnectionEntry,
  tenantIdConnection,
} from './mongoose.constants.js';

// One singleton per registered core module, independent of request-scoped options.
@Injectable()
export class MongooseConnectionManager implements OnApplicationShutdown {
  private readonly owner = Symbol('mongoose connection owner');
  private readonly entries = new Map<string, TenantConnectionEntry>();
  private readonly uncached = new Set<Connection>();
  private readonly pending = new Set<Promise<Connection>>();
  private shutdown?: Promise<void>;

  acquire(
    key: string | undefined,
    create: () => Promise<Connection>,
  ): Promise<Connection> {
    if (this.shutdown) {
      return Promise.reject(
        new Error('Mongoose connection manager is shutting down'),
      );
    }
    const operation = this.acquireConnection(key, create);
    this.pending.add(operation);
    return operation.finally(() => this.pending.delete(operation));
  }

  private async acquireConnection(
    key: string | undefined,
    create: () => Promise<Connection>,
  ): Promise<Connection> {
    if (key === undefined) {
      const connection = await create();
      this.uncached.add(connection);
      return connection;
    }

    let entry = tenantIdConnection.get(key);
    if (!entry) {
      entry = { promise: Promise.resolve().then(create), owners: new Set() };
      tenantIdConnection.set(key, entry);
    }
    // Repeated requests add the same owner, so ownership does not grow per request.
    entry.owners.add(this.owner);
    this.entries.set(key, entry);
    try {
      const connection = await entry.promise;
      entry.connection = connection;
      return connection;
    } catch (error) {
      if (tenantIdConnection.get(key) === entry) tenantIdConnection.delete(key);
      if (this.entries.get(key) === entry) this.entries.delete(key);
      entry.owners.delete(this.owner);
      throw error;
    }
  }

  onApplicationShutdown(): Promise<void> {
    this.shutdown ??= this.closeConnections();
    return this.shutdown;
  }

  private async closeConnections(): Promise<void> {
    // Include connections whose creation was already in progress at shutdown.
    await Promise.allSettled(this.pending);
    const connections = new Set(this.uncached);
    this.uncached.clear();
    for (const [key, entry] of this.entries) {
      entry.owners.delete(this.owner);
      if (entry.owners.size === 0) {
        if (tenantIdConnection.get(key) === entry)
          tenantIdConnection.delete(key);
        if (entry.connection) connections.add(entry.connection);
      }
    }
    this.entries.clear();
    const results = await Promise.allSettled(
      [...connections].map(async (connection) => {
        await connection.close();
      }),
    );
    const errors = results.filter((result) => result.status === 'rejected');
    if (errors.length) {
      throw new AggregateError(
        errors.map((result) => result.reason),
        'Failed to close Mongoose connections',
      );
    }
  }
}
