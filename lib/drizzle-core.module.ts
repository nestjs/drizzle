import {
  DynamicModule,
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
  Provider,
  Type,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  closeDrizzleClient,
  getDrizzleClients,
  getDrizzleToken,
  watchDrizzleClient,
} from './common/drizzle.utils.js';
import {
  DEFAULT_CONNECTION_NAME,
  DRIZZLE_MODULE_DATABASE,
  DRIZZLE_MODULE_ID,
  DRIZZLE_MODULE_OPTIONS,
} from './drizzle.constants.js';
import type {
  DrizzleFunction,
  DrizzleModuleAsyncOptions,
  DrizzleModuleOptions,
  DrizzleOptionsFactory,
} from './interfaces/index.js';

@Global()
@Module({})
export class DrizzleCoreModule implements OnApplicationShutdown {
  private readonly logger = new Logger('DrizzleModule');

  constructor(
    @Inject(DRIZZLE_MODULE_OPTIONS)
    private readonly options: DrizzleModuleOptions,
    @Inject(DRIZZLE_MODULE_DATABASE)
    private readonly db: unknown,
  ) {
    for (const client of getDrizzleClients(this.db)) {
      watchDrizzleClient(client, (error) =>
        this.logger.error(
          'Database connection error',
          error instanceof Error ? error.stack : String(error),
        ),
      );
    }
  }

  static forRoot(options: DrizzleModuleOptions): DynamicModule {
    // Nest serializes dynamic module metadata to compute module keys when
    // `moduleIdGeneratorAlgorithm` is set to "deep-hash" or `snapshot` is
    // enabled (e.g., for Devtools). A database (and its connection pool)
    // must stay out of that metadata, so the options are only reachable
    // through a closure, never through a `useValue` provider.
    const optionsProvider: Provider = {
      provide: DRIZZLE_MODULE_OPTIONS,
      useFactory: () => options,
    };
    return this.createDynamicModule(options?.name, [optionsProvider]);
  }

  static forRootAsync(options: DrizzleModuleAsyncOptions): DynamicModule {
    return this.createDynamicModule(
      options.name,
      this.createAsyncProviders(options),
      options.imports,
    );
  }

  async onApplicationShutdown() {
    if (this.options.autoCloseConnection === false) {
      return;
    }
    await Promise.all(
      getDrizzleClients(this.db).map(async (client) => {
        try {
          await closeDrizzleClient(client);
        } catch (err) {
          this.logger.error(
            'Unable to close the database connection',
            err instanceof Error ? err.stack : String(err),
          );
        }
      }),
    );
  }

  private static createDynamicModule(
    name: string | undefined,
    optionsProviders: Provider[],
    imports: DynamicModule['imports'] = [],
  ): DynamicModule {
    const databaseProvider: Provider = {
      provide: DRIZZLE_MODULE_DATABASE,
      useFactory: (options: DrizzleModuleOptions) =>
        this.createDatabase(options, name),
      inject: [DRIZZLE_MODULE_OPTIONS],
    };
    const exportedDatabaseProvider: Provider = {
      provide: getDrizzleToken(name),
      useFactory: (db: unknown) => db,
      inject: [DRIZZLE_MODULE_DATABASE],
    };

    return {
      module: DrizzleCoreModule,
      imports,
      providers: [
        ...optionsProviders,
        databaseProvider,
        exportedDatabaseProvider,
        // Keeps the keys of separate registrations apart when Nest derives
        // module keys from their metadata ("deep-hash").
        {
          provide: DRIZZLE_MODULE_ID,
          useValue: randomUUID(),
        },
      ],
      exports: [exportedDatabaseProvider],
    };
  }

  private static createDatabase(
    options: DrizzleModuleOptions | undefined,
    name: string | undefined,
  ): unknown {
    if (name !== undefined && name.trim() === '') {
      // A name left empty by a `?? ''` or a config default would resolve to
      // the token of the default connection, and the two registrations would
      // overwrite one another without saying so.
      throw new Error(
        'DrizzleModule received an empty "name". Leave it out to register the default connection, or pass a name for this one.',
      );
    }
    const connection =
      name && name !== DEFAULT_CONNECTION_NAME ? ` ("${name}")` : '';
    const hasDatabase = options?.db !== undefined && options?.db !== null;
    const hasDrizzle = options?.drizzle !== undefined;
    if (hasDatabase && hasDrizzle) {
      throw new Error(
        `DrizzleModule${connection} received both a "db" and a "drizzle" option. Pass either a database instance ("db") or a drizzle() function with its "connection" ("drizzle").`,
      );
    }
    if (hasDatabase) {
      return options!.db;
    }
    if (typeof options?.drizzle === 'function') {
      const {
        name: _name,
        autoCloseConnection: _autoCloseConnection,
        db: _db,
        drizzle,
        ...config
      } = options as DrizzleModuleOptions & { drizzle: DrizzleFunction };
      return drizzle(config);
    }
    if (hasDrizzle) {
      throw new Error(
        `DrizzleModule${connection} received a "drizzle" option that isn't a function. Pass the drizzle() function exported by your driver's entry point (e.g., drizzle-orm/node-postgres).`,
      );
    }
    const receivedDatabase =
      typeof options === 'object' && options !== null && '$client' in options;
    throw new Error(
      receivedDatabase
        ? `DrizzleModule${connection} received a database instance instead of the module options. Pass it as the "db" option: { db }.`
        : `DrizzleModule${connection} was registered without a "db" or "drizzle" option. Pass the database instance returned by Drizzle's drizzle() function ("db"), or the drizzle() function and a "connection" ("drizzle").`,
    );
  }

  private static createAsyncProviders(
    options: DrizzleModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    if (!options.useClass) {
      throw new Error(
        'DrizzleModule.forRootAsync() requires one of "useFactory", "useClass" or "useExisting".',
      );
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: DrizzleModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: DRIZZLE_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    // `as Type<DrizzleOptionsFactory>` is a workaround for microsoft/TypeScript#31603
    const inject = [
      (options.useClass || options.useExisting) as Type<DrizzleOptionsFactory>,
    ];
    return {
      provide: DRIZZLE_MODULE_OPTIONS,
      useFactory: async (optionsFactory: DrizzleOptionsFactory) =>
        await optionsFactory.createDrizzleOptions(options.name),
      inject,
    };
  }
}
