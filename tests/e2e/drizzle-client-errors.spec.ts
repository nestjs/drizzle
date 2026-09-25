import { EventEmitter } from 'events';
import { INestApplicationContext, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle as nodePostgres } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import {
  DrizzleModule,
  DrizzleModuleOptions,
  getDrizzleToken,
} from '../../lib/index.js';

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
});
