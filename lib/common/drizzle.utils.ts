import { DEFAULT_CONNECTION_NAME } from '../drizzle.constants.js';

/**
 * Returns the injection token of the Drizzle database registered under the
 * given connection name.
 * @param {string} [name='default'] Connection name
 * @returns {string} The database injection token
 *
 * @publicApi
 */
export function getDrizzleToken(
  name: string = DEFAULT_CONNECTION_NAME,
): string {
  return name === DEFAULT_CONNECTION_NAME
    ? 'DrizzleDatabase'
    : `${name}DrizzleDatabase`;
}

type DrizzleClient = {
  end?: () => unknown;
  close?: () => unknown;
  promise?: () => DrizzleClient;
  on?: (event: 'error', listener: (error: unknown) => void) => unknown;
  listenerCount?: (event: 'error') => number;
};
type PooledConnection = {
  on(event: 'error', listener: (error: unknown) => void): unknown;
  removeListener(event: 'error', listener: (error: unknown) => void): unknown;
  listenerCount(event: 'error'): number;
};
type NodePostgresPool = {
  totalCount: number;
  on(
    event: 'acquire',
    listener: (connection: PooledConnection) => void,
  ): unknown;
  on(
    event: 'release',
    listener: (error: unknown, connection: PooledConnection) => void,
  ): unknown;
};
type DrizzleDatabaseLike = {
  $client?: unknown;
  $primary?: DrizzleDatabaseLike;
  $replicas?: DrizzleDatabaseLike[];
};

const closedClients = new WeakSet<object>();
const watchedClients = new WeakSet<object>();

/**
 * Returns the driver clients a Drizzle database holds: `db.$client` and, for a
 * database created with `withReplicas()`, the clients of its primary and
 * replica databases (`$primary` and `$replicas`, since Drizzle 0.44.6).
 */
export function getDrizzleClients(db: unknown): DrizzleClient[] {
  const database = db as DrizzleDatabaseLike | null | undefined;
  const databases = [
    database,
    database?.$primary,
    ...(Array.isArray(database?.$replicas) ? database.$replicas : []),
  ];
  const clients = new Set<DrizzleClient>();
  for (const candidate of databases) {
    const client = candidate?.$client;
    if (
      client &&
      (typeof client === 'object' || typeof client === 'function')
    ) {
      clients.add(client as DrizzleClient);
    }
  }
  return [...clients];
}

/**
 * Closes a driver client, unless it's already been closed (e.g., because the
 * same database is registered under several connection names). Pool-based
 * drivers (node-postgres, postgres.js, mysql2, Neon WebSocket) expose `end()`,
 * embedded ones (better-sqlite3, libSQL, PGlite, Bun SQL) expose `close()`,
 * and HTTP drivers (Neon HTTP, D1, PlanetScale) hold nothing open.
 */
export async function closeDrizzleClient(client: DrizzleClient): Promise<void> {
  if (closedClients.has(client)) {
    return;
  }
  closedClients.add(client);
  // mysql2 callback clients (detected the way Drizzle detects them) end in the
  // background. Their promise wrapper resolves once they're closed.
  const target =
    typeof client.promise === 'function' ? client.promise() : client;
  if (typeof target.end === 'function') {
    await target.end();
  } else if (typeof target.close === 'function') {
    await target.close();
  }
}

/**
 * Listens for the errors a driver client emits in the background, unless
 * something already does: this module (e.g., because the same database is
 * registered under several connection names) or the application, which then
 * keeps full control over how they're handled. A node-postgres pool (and the
 * Neon WebSocket pool built on it) emits `error` when the server drops an idle
 * connection: a restart, a failover, a network partition. The pool has
 * already discarded that connection and opens a fresh one for the next query;
 * with no listener, Node raises the event as an uncaught exception and the
 * process exits. A single node-postgres `Client` passed as `db` emits the same
 * event, but can't reconnect: its queries fail from then on, so an application
 * that relies on one should attach its own listener. Other clients either
 * handle it themselves (mysql2 listens on each pooled connection, postgres.js
 * reconnects) or are not event emitters (better-sqlite3, libSQL, PGlite, the
 * HTTP drivers), so the listener is attached wherever `on()` exists and is
 * inert elsewhere. A node-postgres pool's checked-out connections are watched
 * as well, whether or not the application listens on the pool itself (see
 * `watchCheckedOutConnections()`).
 */
export function watchDrizzleClient(
  client: DrizzleClient,
  onError: (error: unknown) => void,
): void {
  if (typeof client.on !== 'function' || watchedClients.has(client)) {
    return;
  }
  watchedClients.add(client);
  if (isNodePostgresPool(client)) {
    watchCheckedOutConnections(client, onError);
  }
  if ((client.listenerCount?.('error') ?? 0) > 0) {
    return;
  }
  client.on('error', onError);
}

/**
 * A node-postgres pool, or the Neon WebSocket pool built on it, recognized by
 * the connection counter pg-pool exposes, so this module never loads `pg`.
 * mysql2 pools have no `totalCount`.
 */
function isNodePostgresPool(
  client: DrizzleClient,
): client is DrizzleClient & NodePostgresPool {
  return typeof (client as Partial<NodePostgresPool>).totalCount === 'number';
}

/**
 * Listens for the errors of a node-postgres pool's connections while they're
 * checked out. pg-pool listens on an idle connection itself, but removes that
 * listener when it hands the connection out, and puts it back on release. A
 * connection from `pool.connect()` therefore has no `error` listener while
 * it's in use, and Drizzle's `transaction()` runs on one: a connection the
 * server drops mid-transaction (a restart, a failover,
 * `pg_terminate_backend()`) emits `error` on an object nobody listens to, and
 * the process exits. The listener only keeps that event from becoming an
 * uncaught exception: the query in flight rejects with the error either way.
 * pg-pool emits `acquire` while its own idle listener is still attached, so a
 * connection that already has another listener belongs to the application
 * and is left alone.
 */
function watchCheckedOutConnections(
  pool: NodePostgresPool,
  onError: (error: unknown) => void,
): void {
  const watchedConnections = new WeakSet<PooledConnection>();
  pool.on('acquire', (connection) => {
    if (connection.listenerCount('error') > 1) {
      return;
    }
    watchedConnections.add(connection);
    connection.on('error', onError);
  });
  pool.on('release', (_error, connection) => {
    if (watchedConnections.delete(connection)) {
      connection.removeListener('error', onError);
    }
  });
}
