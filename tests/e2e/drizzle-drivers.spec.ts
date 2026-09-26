import { DynamicModule, INestApplicationContext, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle as libsql } from 'drizzle-orm/libsql';
import { int as mysqlInt, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { drizzle as mysql2 } from 'drizzle-orm/mysql2';
import { drizzle as nodePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as pglite } from 'drizzle-orm/pglite';
import { pgTable, serial, text as pgText } from 'drizzle-orm/pg-core';
import { drizzle as postgresJs } from 'drizzle-orm/postgres-js';
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DrizzleModule, getDrizzleToken } from '../../lib/index.js';
import { MYSQL_URL, POSTGRES_URL } from '../src/db/services.js';

// drizzle-orm 1.0.0-rc.4 sets `config` on the mysql2 promise pool it creates,
// which has no `config`, so every mysql2 connection fails. The next release
// candidate fixes it.
const drizzleVersion: string = JSON.parse(
  readFileSync(
    new URL('../../node_modules/drizzle-orm/package.json', import.meta.url),
    'utf8',
  ),
).version;
const mysql2Broken = drizzleVersion === '1.0.0-rc.4';

interface Driver {
  register(): DynamicModule;
  table(name: string): any;
  createTable(name: string): ReturnType<typeof sql.raw>;
  /** Runs raw SQL: `execute()` on PostgreSQL and MySQL, `run()` on SQLite. */
  run?(db: any, query: ReturnType<typeof sql.raw>): Promise<unknown>;
  cleanup?(): void;
  skip?: boolean;
}

const run = (driver: Driver, db: any, query: ReturnType<typeof sql.raw>) =>
  driver.run ? driver.run(db, query) : db.execute(query);

const pg: Pick<Driver, 'table' | 'createTable'> = {
  table: (name) =>
    pgTable(name, {
      id: serial('id').primaryKey(),
      name: pgText('name').notNull(),
    }),
  createTable: (name) =>
    sql.raw(`CREATE TABLE ${name} (id serial PRIMARY KEY, name text NOT NULL)`),
};

// libSQL runs transactions on a separate connection, which an in-memory
// database doesn't share, so the SQLite database lives in a temporary file.
const sqliteFile = join(tmpdir(), `nestjs-drizzle-${randomUUID()}.db`);

const drivers: Record<string, Driver> = {
  'node-postgres': {
    register: () =>
      DrizzleModule.forRoot({
        drizzle: nodePostgres,
        connection: POSTGRES_URL,
      }),
    ...pg,
  },
  'postgres.js': {
    register: () =>
      DrizzleModule.forRoot({ drizzle: postgresJs, connection: POSTGRES_URL }),
    ...pg,
  },
  pglite: {
    register: () =>
      DrizzleModule.forRoot({ drizzle: pglite, connection: 'memory://' }),
    ...pg,
  },
  mysql2: {
    skip: mysql2Broken,
    register: () =>
      DrizzleModule.forRoot({ drizzle: mysql2, connection: MYSQL_URL }),
    table: (name) =>
      mysqlTable(name, {
        id: mysqlInt('id').primaryKey().autoincrement(),
        name: varchar('name', { length: 255 }).notNull(),
      }),
    createTable: (name) =>
      sql.raw(
        `CREATE TABLE ${name} (id int AUTO_INCREMENT PRIMARY KEY, name varchar(255) NOT NULL)`,
      ),
  },
  libsql: {
    register: () =>
      DrizzleModule.forRoot({
        drizzle: libsql,
        connection: { url: `file:${sqliteFile}` },
      }),
    table: (name) =>
      sqliteTable(name, {
        id: sqliteInteger('id').primaryKey({ autoIncrement: true }),
        name: sqliteText('name').notNull(),
      }),
    createTable: (name) =>
      sql.raw(
        `CREATE TABLE ${name} (id integer PRIMARY KEY AUTOINCREMENT, name text NOT NULL)`,
      ),
    run: (db, query) => db.run(query),
    cleanup: () => rmSync(sqliteFile, { force: true }),
  },
};

async function boot(...imports: DynamicModule[]) {
  @Module({ imports })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  return moduleRef.init();
}

describe.each(Object.entries(drivers))('Drizzle - %s', (_, driver) => {
  let app: INestApplicationContext | undefined;
  const tableName = `photos_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    driver.cleanup?.();
  });

  it.skipIf(driver.skip)(
    'should run queries and transactions, and close the client on shutdown',
    async () => {
      app = await boot(driver.register());
      const db: any = app.get(getDrizzleToken());
      const photos = driver.table(tableName);

      await run(driver, db, driver.createTable(tableName));
      try {
        await db.insert(photos).values([{ name: 'Nest' }, { name: 'Drizzle' }]);
        const rows = await db.select().from(photos).orderBy(photos.id);
        expect(rows.map((row: { name: string }) => row.name)).toEqual([
          'Nest',
          'Drizzle',
        ]);

        await expect(
          db.transaction(async (tx: any) => {
            await tx.insert(photos).values({ name: 'Rolled back' });
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect(await db.select().from(photos)).toHaveLength(2);
      } finally {
        await run(driver, db, sql.raw(`DROP TABLE ${tableName}`));
      }

      await app.close();
      app = undefined;
      // The module closed the driver's client, so it can't run queries anymore.
      await expect(run(driver, db, sql.raw('SELECT 1'))).rejects.toThrow();
    },
  );
});

describe('Drizzle - PostgreSQL and MySQL in one application', () => {
  it.skipIf(mysql2Broken)(
    'should register and close a database per driver',
    async () => {
      const app = await boot(
        DrizzleModule.forRoot({
          drizzle: nodePostgres,
          connection: POSTGRES_URL,
        }),
        DrizzleModule.forRoot({
          name: 'mysql',
          drizzle: mysql2,
          connection: MYSQL_URL,
        }),
      );
      const postgresDb: any = app.get(getDrizzleToken());
      const mysqlDb: any = app.get(getDrizzleToken('mysql'));

      const [postgresVersion] = (
        await postgresDb.execute(sql`SELECT version() AS version`)
      ).rows;
      const [[mysqlVersion]] = await mysqlDb.execute(
        sql`SELECT version() AS version`,
      );
      expect(postgresVersion.version).toMatch(/PostgreSQL/);
      expect(mysqlVersion.version).toMatch(/^\d+\.\d+/);

      await app.close();
      await expect(postgresDb.execute(sql`SELECT 1`)).rejects.toThrow();
      await expect(mysqlDb.execute(sql`SELECT 1`)).rejects.toThrow();
    },
  );
});
