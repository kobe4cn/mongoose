import { Connection } from 'mongoose';

export const DEFAULT_DB_CONNECTION = 'DatabaseConnection';
export const MONGOOSE_MODULE_OPTIONS = 'MongooseModuleOptions';
export const MONGOOSE_CONNECTION_NAME = 'MongooseConnectionName';

export const RAW_OBJECT_DEFINITION = 'RAW_OBJECT_DEFINITION';
export interface TenantConnectionEntry {
  promise: Promise<Connection>;
  connection?: Connection;
  owners: Set<symbol>;
}

export const tenantIdConnection = new Map<string, TenantConnectionEntry>();
