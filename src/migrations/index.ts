import type { PoolClient } from 'pg';
import * as adminAccount from './001_admin_account';
import * as retention from './002_retention';
import * as security from './003_security';

export interface Migration {
  /** Recorded in `schema_migrations` once applied; never rename or reorder a released one. */
  id: string;
  up(db: PoolClient): Promise<void>;
}

/** Applied in order, each exactly once, after the base schema in db.ts. Append new ones at the end. */
export const MIGRATIONS: Migration[] = [
  { id: '001_admin_account', up: adminAccount.up },
  { id: '002_retention', up: retention.up },
  { id: '003_security', up: security.up },
];
