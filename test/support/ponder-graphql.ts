import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import * as schema from '../../ponder.schema.ts';

type Row = Record<string, unknown>;
type ResolverModules = any;

const PONDER = realpathSync(join(process.cwd(), 'node_modules/ponder'));
const ponderRequire = createRequire(join(PONDER, 'package.json'));
const load = (path: string) => import(pathToFileURL(path).href);

export type PonderIndexer = {
  indexer: {
    query<T>(
      query: string,
      variables?: Record<string, unknown>,
      cacheKey?: string,
    ): Promise<T>;
  };
  requests: Array<{ query: string; variables: Record<string, unknown> }>;
  measureOperation(query: string): { tokens: number; aliases: number };
  close(): Promise<void>;
};

export async function startPonderIndexer(
  rowsOf: (table: object) => Row[],
): Promise<PonderIndexer> {
  const [{ PGlite }, drizzleModule, kitModule, graphqlModule, resolverModule] =
    await Promise.all([
      load(ponderRequire.resolve('@electric-sql/pglite')) as Promise<{
        PGlite: new () => any;
      }>,
      load(ponderRequire.resolve('drizzle-orm/pglite')) as Promise<{
        drizzle: (client: unknown, options: unknown) => any;
      }>,
      load(join(PONDER, 'dist/esm/drizzle/kit/index.js')) as Promise<{
        getSql(schema: object): { tables: { sql: string[] } };
      }>,
      load(ponderRequire.resolve('graphql')) as Promise<ResolverModules>,
      load(join(PONDER, 'dist/esm/graphql/index.js')) as Promise<{
        buildGraphQLSchema(input: { schema: typeof schema }): unknown;
      }>,
    ]);
  const drizzle = drizzleModule.drizzle.bind(drizzleModule);
  const getSql = kitModule.getSql.bind(kitModule);
  const buildGraphQLSchema =
    resolverModule.buildGraphQLSchema.bind(resolverModule);
  const pglite = new PGlite();
  for (const statement of getSql(schema).tables.sql) {
    if (!statement.includes('_reorg__')) await pglite.exec(statement);
  }
  const db = drizzle(pglite, { schema, casing: 'snake_case' });
  for (const table of Object.values(schema)) {
    const rows = rowsOf(table);
    if (rows.length) await db.insert(table).values(rows);
  }

  const graphqlSchema = buildGraphQLSchema({ schema });
  const requests: PonderIndexer['requests'] = [];
  const server: Server = createServer(async (request, response) => {
    if (request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ robinhood: { block: { timestamp: Math.floor(Date.now() / 1_000) } } }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      query: string;
      variables?: Record<string, unknown>;
    };
    requests.push({ query: body.query, variables: body.variables ?? {} });
    const document = graphqlModule.parse(body.query);
    const errors = graphqlModule.validate(graphqlSchema, document);
    const result = errors.length
      ? { errors }
      : await graphqlModule.execute({
          schema: graphqlSchema,
          document,
          variableValues: body.variables,
          contextValue: {
            qb: {
              raw: db,
              wrap: (fn: (database: typeof db) => unknown) => fn(db),
            },
            getDataLoader: () => {
              throw new Error('Unexpected singular GraphQL resolver');
            },
          },
        });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const { IndexerService } =
    await import('../../src/indexer/indexer.service.js');
  const { TtlCacheService } =
    await import('../../src/shared/ttl-cache.service.js');
  const indexer = new IndexerService(
    {
      indexerGraphqlUrl: `http://127.0.0.1:${port}/graphql`,
      indexerStatusUrl: `http://127.0.0.1:${port}/status`,
      maxIndexerLagSeconds: 60,
    } as never,
    new TtlCacheService(),
  );

  return {
    indexer,
    requests,
    measureOperation(query) {
      const source = new graphqlModule.Source(query);
      const lexer = new graphqlModule.Lexer(source);
      let tokens = 0;
      while (lexer.advance().kind !== graphqlModule.TokenKind.EOF) tokens++;
      const document = graphqlModule.parse(query);
      const countAliases = (selectionSet: { selections: Array<any> }): number =>
        selectionSet.selections.reduce(
          (count, selection) =>
            count +
            (selection.kind === graphqlModule.Kind.FIELD && selection.alias
              ? 1
              : 0) +
            (selection.selectionSet ? countAliases(selection.selectionSet) : 0),
          0,
        );
      return {
        tokens,
        aliases: document.definitions.reduce(
          (count: number, definition: any) =>
            count +
            (definition.selectionSet
              ? countAliases(definition.selectionSet)
              : 0),
          0,
        ),
      };
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await pglite.close();
    },
  };
}
