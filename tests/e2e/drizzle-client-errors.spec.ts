import { EventEmitter } from 'events';
import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle as nodePostgres } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import {
  DrizzleModule,
  DrizzleModuleOptions,
  getDrizzleToken,
} from '../../lib/index.js';
import { POSTGRES_URL } from '../src/db/services.js';

// Closed in afterEach, so a failing assertion never leaks the application.
let app: INestApplicationContext | undefined;

async function boot(...registrations: DrizzleModuleOptions[]) {
  @Module({
    imports: registrations.map((options) => DrizzleModule.forRoot(options)),
  })
  class AppModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = await moduleRef.init();
  return app;
}

function poolLikeClient() {
  return Object.assign(new EventEmitter(), { end: vi.fn() });
}

// Mimics pg-pool's bookkeeping: an idle connection has pg-pool's own `error`
// listener, which it removes after emitting `acquire` and puts back on
// release.
function nodePostgresPoolLike() {
  const pool = Object.assign(new EventEmitter(), {
    end: vi.fn(),
    totalCount: 0,
  });
  const idleListener = vi.fn();
  const connection = new EventEmitter();
  connection.on('error', idleListener);
  return {
    pool,
    connection,
    checkOut() {
      pool.emit('acquire', connection);
      connection.removeListener('error', idleListener);
    },
    release() {
      connection.on('error', idleListener);
      pool.emit('release', undefined, connection);
    },
  };
}

describe('Drizzle - client errors', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });

  it('should log (not crash) when a client the module created emits an error', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    // An unreachable server: the pool never connects, and emits `error` the
    // way it does for an idle client the server drops.
    const application = await boot({
      drizzle: nodePostgres,
      connection: { host: '127.0.0.1', port: 1 },
    });
    const pool: Pool = application.get(getDrizzleToken()).$client;

    expect(() =>
      pool.emit(
        'error',
        new Error('terminating connection due to administrator command'),
      ),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      'Database connection error',
      expect.stringContaining('terminating connection'),
    );
  });

  it('should log (not crash) when a client passed as "db" emits an error', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const client = poolLikeClient();
    await boot({ db: { $client: client } });

    expect(() =>
      client.emit('error', new Error('connection reset')),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      'Database connection error',
      expect.stringContaining('connection reset'),
    );
  });

  it('should listen once on a client shared by several registrations', async () => {
    const client = poolLikeClient();
    await boot(
      { db: { $client: client } },
      { name: 'analytics', db: { $client: client } },
    );
    expect(client.listenerCount('error')).toBe(1);
  });

  it('should leave a client alone when the application already listens', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const onError = vi.fn();
    const client = poolLikeClient();
    client.on('error', onError);
    await boot({ db: { $client: client } });

    client.emit('error', new Error('connection reset'));
    expect(client.listenerCount('error')).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('should skip clients that are not event emitters', async () => {
    await expect(
      boot(
        { db: { $client: () => undefined } },
        { name: 'other', db: { $client: { close: vi.fn() } } },
      ),
    ).resolves.toBeDefined();
  });

  it('should log (not crash) when a checked-out pool connection emits an error', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { pool, connection, checkOut } = nodePostgresPoolLike();
    await boot({ db: { $client: pool } });

    checkOut();
    expect(() =>
      connection.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      'Database connection error',
      expect.stringContaining('Connection terminated unexpectedly'),
    );
  });

  it('should stop listening on a pool connection once it is released', async () => {
    const { pool, connection, checkOut, release } = nodePostgresPoolLike();
    await boot({ db: { $client: pool } });

    checkOut();
    expect(connection.listenerCount('error')).toBe(1);
    release();
    // pg-pool's idle listener only.
    expect(connection.listenerCount('error')).toBe(1);
    checkOut();
    expect(connection.listenerCount('error')).toBe(1);
  });

  it('should leave a pool connection alone when the application listens on it', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const onError = vi.fn();
    const { pool, connection, checkOut } = nodePostgresPoolLike();
    connection.on('error', onError);
    await boot({ db: { $client: pool } });

    checkOut();
    connection.emit('error', new Error('connection reset'));
    expect(onError).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });

  it('should watch checked-out connections even when the application listens on the pool', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { pool, connection, checkOut } = nodePostgresPoolLike();
    pool.on('error', vi.fn());
    await boot({ db: { $client: pool } });

    checkOut();
    expect(() =>
      connection.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(pool.listenerCount('error')).toBe(1);
    expect(error).toHaveBeenCalledOnce();
  });

  it('should reject (not crash) a transaction whose connection the server terminates', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const application = await boot({
      drizzle: nodePostgres,
      connection: POSTGRES_URL,
    });
    const db = application.get(getDrizzleToken());
    const admin = new Client({ connectionString: POSTGRES_URL });
    await admin.connect();
    try {
      await expect(
        db.transaction(async (tx: typeof db) => {
          const { rows } = await tx.execute(
            sql`select pg_backend_pid() as pid`,
          );
          await admin.query('select pg_terminate_backend($1)', [rows[0].pid]);
          await tx.execute(sql`select 1`);
        }),
      ).rejects.toThrow();
    } finally {
      await admin.end();
    }
    expect(error).toHaveBeenCalledWith(
      'Database connection error',
      expect.stringContaining('terminat'),
    );
  });

  it('should listen on clients of primary and replica databases', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const primaryClient = poolLikeClient();
    const replicaClient = poolLikeClient();

    await boot({
      db: {
        $client: primaryClient,
        $primary: { $client: primaryClient },
        $replicas: [{ $client: replicaClient }],
      },
    });

    expect(primaryClient.listenerCount('error')).toBe(1);
    expect(replicaClient.listenerCount('error')).toBe(1);

    replicaClient.emit('error', new Error('replica connection dropped'));
    expect(error).toHaveBeenCalledWith(
      'Database connection error',
      expect.stringContaining('replica connection dropped'),
    );
  });
});
