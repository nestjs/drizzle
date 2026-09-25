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
 * inert elsewhere.
 */
export function watchDrizzleClient(
  client: DrizzleClient,
  onError: (error: unknown) => void,
): void {
  if (typeof client.on !== 'function' || watchedClients.has(client)) {
    return;
  }
  watchedClients.add(client);
  if ((client.listenerCount?.('error') ?? 0) > 0) {
    return;
  }
  client.on('error', onError);
}
