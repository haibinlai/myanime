import path from "node:path";
import {
  MAX_BATCH_SIZE,
  SHARE_ALIAS_TABLE,
  SHARE_SUBJECT_SLOT_TABLE,
  SHARE_VIEW_TOTAL_TABLE,
  SHARES_V2_TABLE,
  SYSTEM_CHECKPOINT_TABLE,
  SUBJECT_DIM_TABLE,
  SUBJECT_GENRE_DIM_TABLE,
  TREND_COUNT_ALL_TABLE,
  TREND_COUNT_DAY_TABLE,
  TREND_COUNT_HOUR_TABLE,
  TRENDS_CACHE_TABLE,
  chunkArray,
  parsePositiveInt,
  readEnv,
} from "@/lib/share/storage-common";

export type D1Scalar = string | number | null;

export type D1PreparedStatementLike = {
  bind: (...values: D1Scalar[]) => D1PreparedStatementLike;
  all: <T = Record<string, unknown>>() => Promise<{ results?: T[] } | T[]>;
  run: () => Promise<{ meta?: { changes?: number } } | { changes?: number } | unknown>;
};

export type D1DatabaseLike = {
  prepare: (query: string) => D1PreparedStatementLike;
  batch: (statements: D1PreparedStatementLike[]) => Promise<unknown[]>;
  exec: (query: string) => Promise<unknown>;
};

export type StatementInput = {
  sql: string;
  params?: D1Scalar[];
};

const D1_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS ${SHARES_V2_TABLE} (
  share_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  creator_name TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  hot_payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_viewed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${SHARES_V2_TABLE}_kind_created_idx
ON ${SHARES_V2_TABLE} (kind, created_at DESC);
CREATE TABLE IF NOT EXISTS ${SHARE_ALIAS_TABLE} (
  share_id TEXT PRIMARY KEY,
  target_share_id TEXT NOT NULL REFERENCES ${SHARES_V2_TABLE}(share_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${SHARE_ALIAS_TABLE}_target_idx
ON ${SHARE_ALIAS_TABLE} (target_share_id);
CREATE TABLE IF NOT EXISTS ${SUBJECT_DIM_TABLE} (
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  localized_name TEXT,
  cover TEXT,
  release_year INTEGER,
  genres TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX IF NOT EXISTS ${SUBJECT_DIM_TABLE}_subject_idx
ON ${SUBJECT_DIM_TABLE} (subject_id);
CREATE TABLE IF NOT EXISTS ${SUBJECT_GENRE_DIM_TABLE} (
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  genre TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id, genre)
);
CREATE INDEX IF NOT EXISTS ${SUBJECT_GENRE_DIM_TABLE}_kind_genre_idx
ON ${SUBJECT_GENRE_DIM_TABLE} (kind, genre, subject_id);
CREATE TABLE IF NOT EXISTS ${SHARE_SUBJECT_SLOT_TABLE} (
  share_id TEXT NOT NULL REFERENCES ${SHARES_V2_TABLE}(share_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  slot_index INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  day_key INTEGER NOT NULL,
  hour_bucket INTEGER NOT NULL,
  PRIMARY KEY (share_id, slot_index)
);
CREATE INDEX IF NOT EXISTS ${SHARE_SUBJECT_SLOT_TABLE}_created_share_slot_idx
ON ${SHARE_SUBJECT_SLOT_TABLE} (created_at, share_id, slot_index);
CREATE TABLE IF NOT EXISTS ${TREND_COUNT_ALL_TABLE} (
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)
);
CREATE INDEX IF NOT EXISTS ${TREND_COUNT_ALL_TABLE}_kind_count_idx
ON ${TREND_COUNT_ALL_TABLE} (kind, count DESC, subject_id);
CREATE TABLE IF NOT EXISTS ${TREND_COUNT_DAY_TABLE} (
  kind TEXT NOT NULL,
  day_key INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, day_key, subject_id)
);
CREATE INDEX IF NOT EXISTS ${TREND_COUNT_DAY_TABLE}_kind_day_count_idx
ON ${TREND_COUNT_DAY_TABLE} (kind, day_key, count DESC, subject_id);
CREATE TABLE IF NOT EXISTS ${TREND_COUNT_HOUR_TABLE} (
  kind TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  subject_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, hour_bucket, subject_id)
);
CREATE INDEX IF NOT EXISTS ${TREND_COUNT_HOUR_TABLE}_kind_hour_count_idx
ON ${TREND_COUNT_HOUR_TABLE} (kind, hour_bucket, count DESC, subject_id);
CREATE TABLE IF NOT EXISTS ${TRENDS_CACHE_TABLE} (
  cache_key TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  view TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${TRENDS_CACHE_TABLE}_expires_idx
ON ${TRENDS_CACHE_TABLE} (expires_at);
CREATE TABLE IF NOT EXISTS ${SYSTEM_CHECKPOINT_TABLE} (
  checkpoint_key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ${SHARE_VIEW_TOTAL_TABLE} (
  share_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  view_count INTEGER NOT NULL,
  last_aggregated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${SHARE_VIEW_TOTAL_TABLE}_kind_count_idx
ON ${SHARE_VIEW_TOTAL_TABLE} (kind, view_count DESC, share_id);
`;

type LocalPlatformEnv = {
  MY9_DB?: D1DatabaseLike;
};

type GlobalRuntimeWithEnv = typeof globalThis & {
  __MY9_CF_ENV?: LocalPlatformEnv;
};

type CloudflareD1HttpResult<T = Record<string, unknown>> = {
  success?: boolean;
  meta?: { changes?: number };
  results?: T[];
};

type CloudflareD1HttpResponse<T = Record<string, unknown>> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: CloudflareD1HttpResult<T>[];
};

let localPlatformPromise: Promise<LocalPlatformEnv | null> | null = null;
let d1DatabasePromise: Promise<D1DatabaseLike | null> | null = null;
let d1SchemaReadyPromise: Promise<boolean> | null = null;
const LOCAL_PLATFORM_TIMEOUT_MS = parsePositiveInt(
  readEnv("MY9_D1_LOCAL_PROXY_TIMEOUT_MS"),
  4000
);
const REMOTE_D1_DATABASE_ID_BY_ENV = {
  production: "6953e552-443b-479d-b6fa-3ffdeac2e60a",
  test: "bdaef170-8163-4c9b-a47a-1086c9e1f54f",
} as const;

function resolveRemoteD1Env() {
  return readEnv("MY9_DB_WRANGLER_ENV", "NEXT_DEV_WRANGLER_ENV") === "test" ? "test" : "production";
}

function resolveRemoteD1DatabaseId(targetEnv: "production" | "test") {
  return targetEnv === "test"
    ? readEnv("MY9_REMOTE_D1_DATABASE_ID_TEST", "MY9_REMOTE_D1_DATABASE_ID") || REMOTE_D1_DATABASE_ID_BY_ENV.test
    : readEnv("MY9_REMOTE_D1_DATABASE_ID") || REMOTE_D1_DATABASE_ID_BY_ENV.production;
}

function escapeSqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function toSqlLiteral(value: D1Scalar) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("cannot serialize non-finite number for remote D1 query");
    }
    return String(value);
  }
  return escapeSqlString(value);
}

function inlineSqlParams(sql: string, params: D1Scalar[]) {
  let index = 0;
  const expanded = sql.replace(/\?/g, () => {
    if (index >= params.length) {
      throw new Error("not enough params provided for remote D1 batch");
    }
    const literal = toSqlLiteral(params[index]);
    index += 1;
    return literal;
  });

  if (index !== params.length) {
    throw new Error("too many params provided for remote D1 batch");
  }

  return expanded;
}

async function dynamicRuntimeImport<T = unknown>(specifier: string): Promise<T> {
  const importer = new Function("s", "return import(s);") as (s: string) => Promise<T>;
  return importer(specifier);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function getCloudflareBoundD1(): Promise<D1DatabaseLike | null> {
  const globalEnv = (globalThis as GlobalRuntimeWithEnv).__MY9_CF_ENV;
  const globalDb = globalEnv?.MY9_DB;
  if (globalDb && typeof globalDb.prepare === "function") {
    return globalDb;
  }

  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const context = (await getCloudflareContext({ async: true })) as { env?: LocalPlatformEnv };
    const db = context?.env?.MY9_DB;
    return db && typeof db.prepare === "function" ? db : null;
  } catch {
    return null;
  }
}

async function executeRemoteD1Query<T = Record<string, unknown>>(
  sql: string,
  params: D1Scalar[] = []
): Promise<CloudflareD1HttpResult<T>[]> {
  const accountId = readEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = readEnv("MY9_SQL_API_TOKEN", "CLOUDFLARE_API_TOKEN");
  const databaseId = resolveRemoteD1DatabaseId(resolveRemoteD1Env());

  if (!accountId || !token || !databaseId) {
    throw new Error("remote d1 credentials are not configured");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sql,
        ...(params.length > 0 ? { params } : {}),
      }),
      cache: "no-store",
    }
  );

  const payload = (await response.json()) as CloudflareD1HttpResponse<T>;
  const errors = Array.isArray(payload?.errors)
    ? payload.errors.map((item) => item?.message).filter((item): item is string => Boolean(item))
    : [];

  if (!response.ok || payload?.success === false) {
    throw new Error(errors[0] || `remote d1 query failed with status ${response.status}`);
  }

  return Array.isArray(payload?.result) ? payload.result : [];
}

function createRemoteD1Database(): D1DatabaseLike {
  return {
    prepare(query: string) {
      return createRemotePreparedStatement(query);
    },
    async batch(statements: D1PreparedStatementLike[]) {
      const remoteStatements = statements as Array<D1PreparedStatementLike & { sql?: string; params?: D1Scalar[] }>;
      const serializedStatements = remoteStatements.map((statement) => {
        if (typeof statement.sql !== "string") {
          throw new Error("remote d1 batch requires serializable statements");
        }
        return inlineSqlParams(statement.sql, Array.isArray(statement.params) ? statement.params : []);
      });
      const sql = ["BEGIN TRANSACTION", ...serializedStatements, "COMMIT"].join(";\n");
      return await executeRemoteD1Query(sql);
    },
    async exec(query: string) {
      const results = await executeRemoteD1Query(query);
      return {
        count: results.length,
      };
    },
  };
}

function createRemotePreparedStatement(sql: string, boundParams: D1Scalar[] = []): D1PreparedStatementLike & {
  sql: string;
  params: D1Scalar[];
} {
  return {
    sql,
    params: boundParams,
    bind: (...values: D1Scalar[]) => createRemotePreparedStatement(sql, values),
    async all<T = Record<string, unknown>>() {
      const results = await executeRemoteD1Query<T>(sql, boundParams);
      return results[0]?.results ?? [];
    },
    async run() {
      const results = await executeRemoteD1Query(sql, boundParams);
      return results[0] ?? {};
    },
  };
}

async function getLocalPlatformEnv(): Promise<LocalPlatformEnv | null> {
  if (!localPlatformPromise) {
    localPlatformPromise = (async () => {
      try {
        const { getPlatformProxy } = await dynamicRuntimeImport<typeof import("wrangler")>("wrangler");
        const environment = readEnv("MY9_DB_WRANGLER_ENV", "NEXT_DEV_WRANGLER_ENV") ?? undefined;
        const platform = await withTimeout(
          getPlatformProxy<LocalPlatformEnv>({
            configPath: path.resolve(process.cwd(), "wrangler.jsonc"),
            environment,
            persist: true,
            remoteBindings: false,
          }),
          LOCAL_PLATFORM_TIMEOUT_MS
        );
        return platform.env ?? null;
      } catch {
        return null;
      }
    })();
  }
  return localPlatformPromise;
}

export async function getD1Database(): Promise<D1DatabaseLike | null> {
  if (!d1DatabasePromise) {
    d1DatabasePromise = (async () => {
      const bound = await getCloudflareBoundD1();
      if (bound) return bound;

      const localEnv = await getLocalPlatformEnv();
      const localDb = localEnv?.MY9_DB;
      if (localDb && typeof localDb.prepare === "function") {
        return localDb;
      }

      if (
        readEnv("CLOUDFLARE_ACCOUNT_ID") &&
        readEnv("MY9_SQL_API_TOKEN", "CLOUDFLARE_API_TOKEN") &&
        resolveRemoteD1DatabaseId(resolveRemoteD1Env())
      ) {
        return createRemoteD1Database();
      }

      return null;
    })();
  }
  return d1DatabasePromise;
}

export async function ensureD1Schema(): Promise<boolean> {
  const db = await getD1Database();
  if (!db) {
    return false;
  }

  if ((globalThis as GlobalRuntimeWithEnv).__MY9_CF_ENV?.MY9_DB) {
    return true;
  }

  if (!d1SchemaReadyPromise) {
    d1SchemaReadyPromise = (async () => {
      try {
        await db.exec(D1_SCHEMA_SQL);
        return true;
      } catch {
        d1SchemaReadyPromise = null;
        return false;
      }
    })();
  }

  return d1SchemaReadyPromise;
}

export async function isD1RuntimeAvailable(): Promise<boolean> {
  return (await getD1Database()) !== null;
}

export function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function queryAll<T = Record<string, unknown>>(
  db: D1DatabaseLike,
  sql: string,
  params: D1Scalar[] = []
): Promise<T[]> {
  const prepared = db.prepare(sql).bind(...params.map((value) => (value === undefined ? null : value)));
  const result = await prepared.all<T>();
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(result.results) ? result.results : [];
}

export async function queryFirst<T = Record<string, unknown>>(
  db: D1DatabaseLike,
  sql: string,
  params: D1Scalar[] = []
): Promise<T | null> {
  const rows = await queryAll<T>(db, sql, params);
  return rows[0] ?? null;
}

export function readChangeCount(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const record = result as { meta?: { changes?: number }; changes?: number };
  if (typeof record.meta?.changes === "number") return Math.trunc(record.meta.changes);
  if (typeof record.changes === "number") return Math.trunc(record.changes);
  return 0;
}

export async function execute(db: D1DatabaseLike, sql: string, params: D1Scalar[] = []): Promise<number> {
  const result = await db.prepare(sql).bind(...params.map((value) => (value === undefined ? null : value))).run();
  return readChangeCount(result);
}

export async function executeBatch(db: D1DatabaseLike, statements: StatementInput[]): Promise<number> {
  let changes = 0;
  for (const chunk of chunkArray(statements, MAX_BATCH_SIZE)) {
    const result = await db.batch(chunk.map((statement) => db.prepare(statement.sql).bind(...(statement.params ?? []))));
    for (const item of result) {
      changes += readChangeCount(item);
    }
  }
  return changes;
}
