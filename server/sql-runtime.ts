// sql-query module runtime: SQLite, DuckDB, Postgres, MySQL/MariaDB,
// MSSQL, Oracle, MongoDB, Redis. The native drivers (SQLite via bun:sqlite,
// Postgres via Bun.sql) load eagerly; everything else is fetched via
// `loadOptionalPkg` so users only need to install (from the Environnements
// panel) the drivers they actually use. Each branch returns a normalised
// `{ rows, affected, lastInsertRowid }` shape.

import { mkdir } from "node:fs/promises";
import { join, resolve, dirname, sep } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR, N2N_NPM_DIR } from "./config.ts";
import type { RunResult } from "./graph-types.ts";

/**
 * Resolve a SQLite path under the n2n data dir sandbox. Refuses absolute
 * paths outside $HOME so a workflow can't, e.g., overwrite /etc/.
 *
 *   ":memory:"          → ":memory:"
 *   "" or "/"           → ":memory:"
 *   "foo.db"            → ~/.n2n/data/foo.db
 *   "subdir/db.sqlite"  → ~/.n2n/data/subdir/db.sqlite
 *   "~/foo/bar.db"      → ~/foo/bar.db (must stay under home)
 *   "/abs/path.db"      → only allowed if under $HOME
 */
export function resolveSqliteSandboxPath(input: string): string {
  const cleaned = (input || "").trim();
  if (!cleaned || cleaned === ":memory:") return ":memory:";
  let target: string;
  if (cleaned.startsWith("~/")) {
    target = join(homedir(), cleaned.slice(2));
  } else if (cleaned.startsWith("/")) {
    target = resolve(cleaned);
  } else {
    target = join(DATA_DIR, cleaned);
  }
  const resolved = resolve(target);
  const homeReal = resolve(homedir());
  if (resolved !== homeReal && !resolved.startsWith(homeReal + sep)) {
    throw new Error(`Chemin SQLite hors de $HOME refusé: ${input}`);
  }
  return resolved;
}

/**
 * Dynamic import that doesn't fail compile if the package isn't installed.
 * Tries Node's resolution first (NODE_PATH / cwd-relative), then falls back
 * to ~/.n2n/npm/node_modules/<pkg> where we install drivers from the
 * Environnements panel. Returns null on full failure so callers can show
 * a clean "npm i <pkg>" hint.
 */
export async function loadOptionalPkg(name: string): Promise<any> {
  try {
    return await (Function("n", "return import(n)")(name) as Promise<any>);
  } catch { /* fall through */ }
  try {
    const fallback = join(N2N_NPM_DIR, "node_modules", ...name.split("/"));
    return await (Function("p", "return import(p)")(fallback) as Promise<any>);
  } catch {
    return null;
  }
}

export async function runSqlQuery(
  substituted: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<RunResult> {
  const driver = String(substituted.driver || "sqlite");
  const queryRaw = String(substituted.query || "").trim();
  if (!queryRaw) return { ok: false, error: "sql-query: requête vide" };

  // Parameters: prefer the input socket if it's an array, fall back to the
  // text-encoded JSON array param.
  let qparams: unknown[] = [];
  if (Array.isArray(inputs.params)) {
    qparams = inputs.params as unknown[];
  } else {
    const raw = String(substituted.parameters || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) qparams = parsed;
        else return { ok: false, error: "sql-query: parameters doit être un array JSON" };
      } catch (e: any) {
        return { ok: false, error: `sql-query: parameters invalide: ${e?.message || e}` };
      }
    }
  }

  if (driver === "sqlite") {
    let dbPath: string;
    try { dbPath = resolveSqliteSandboxPath(String(substituted.connection || ":memory:")); }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    const createDirs = substituted.create_dirs !== false;
    if (dbPath !== ":memory:" && createDirs) {
      try { await mkdir(dirname(dbPath), { recursive: true }); } catch {}
    }
    let mod: any;
    try { mod = await import("bun:sqlite"); }
    catch (e: any) {
      return { ok: false, error: `sqlite: bun:sqlite indisponible (${e?.message || e})` };
    }
    let db: any;
    try { db = new mod.Database(dbPath); }
    catch (e: any) { return { ok: false, error: `sqlite: open ${dbPath} → ${e?.message || e}` }; }
    try {
      const stmt = db.query(queryRaw);
      // Heuristic: SELECT/PRAGMA/WITH return rows; everything else mutates.
      const isRead = /^\s*(?:select|pragma|with|explain)\b/i.test(queryRaw);
      if (isRead) {
        const rows = stmt.all(...qparams);
        return { ok: true, outputs: { rows, affected: 0, lastInsertRowid: 0 } };
      } else {
        const info = stmt.run(...qparams);
        return {
          ok: true,
          outputs: {
            rows: [],
            affected: Number(info?.changes ?? db.totalChanges ?? 0),
            lastInsertRowid: Number(info?.lastInsertRowid ?? 0),
          },
        };
      }
    } catch (e: any) {
      return { ok: false, error: `sqlite: ${e?.message || e}` };
    } finally {
      try { db.close(); } catch {}
    }
  }

  if (driver === "postgres") {
    const url = String(substituted.connection_pg || substituted.connection || "").trim();
    if (!url) return { ok: false, error: "postgres: URL requise" };
    try {
      // Bun.sql for tagged templates; .unsafe() for arbitrary parameterised SQL.
      const sql = (Bun as any).sql ? (Bun as any).sql(url) : null;
      if (!sql) return { ok: false, error: "postgres: Bun.sql indisponible (Bun >= 1.2 requis)" };
      const rowsAny: any = await sql.unsafe(queryRaw, qparams);
      const rows = Array.isArray(rowsAny) ? rowsAny : [];
      const isRead = /^\s*(?:select|with|explain|show)\b/i.test(queryRaw);
      try { await sql.end?.(); } catch {}
      return {
        ok: true,
        outputs: {
          rows: isRead ? rows : [],
          affected: isRead ? 0 : (Number((rowsAny as any)?.count ?? rows.length ?? 0)),
          lastInsertRowid: 0,
        },
      };
    } catch (e: any) {
      return { ok: false, error: `postgres: ${e?.message || e}` };
    }
  }

  if (driver === "mysql" || driver === "mariadb") {
    const url = String(
      (driver === "mariadb" ? substituted.connection_mariadb : substituted.connection_mysql) ||
      substituted.connection ||
      "",
    ).trim();
    if (!url) return { ok: false, error: `${driver}: URL requise` };
    try {
      // mysql2 also speaks MariaDB wire protocol — same client.
      const mysql2: any = await loadOptionalPkg("mysql2/promise");
      if (!mysql2) {
        return {
          ok: false,
          error: `${driver}: dépendance 'mysql2' non installée (npm i mysql2).`,
        };
      }
      const conn = await mysql2.createConnection(url);
      try {
        const [rowsRaw, fields] = await conn.execute(queryRaw, qparams);
        void fields;
        const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
        const affected = Number((rowsRaw as any)?.affectedRows ?? 0);
        const lastInsertRowid = Number((rowsRaw as any)?.insertId ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid } };
      } finally {
        try { await conn.end(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `${driver}: ${e?.message || e}` };
    }
  }

  if (driver === "mssql") {
    const cs = String(substituted.connection_mssql || substituted.connection || "").trim();
    if (!cs) return { ok: false, error: "mssql: connection string requise" };
    try {
      const mssql: any = await loadOptionalPkg("mssql");
      if (!mssql) {
        return { ok: false, error: "mssql: dépendance 'mssql' non installée (npm i mssql)." };
      }
      const pool = await mssql.connect(cs);
      try {
        const req = pool.request();
        let q = queryRaw;
        let i = 0;
        q = q.replace(/\?/g, () => `@p${i++}`);
        qparams.forEach((p, idx) => req.input(`p${idx}`, p as any));
        const out = await req.query(q);
        const rows = out.recordset || [];
        const affected = Array.isArray(out.rowsAffected)
          ? out.rowsAffected.reduce((a: number, b: number) => a + b, 0)
          : Number(out.rowsAffected ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await pool.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `mssql: ${e?.message || e}` };
    }
  }

  if (driver === "duckdb") {
    let dbPath: string;
    try { dbPath = resolveSqliteSandboxPath(String(substituted.connection_duckdb || ":memory:")); }
    catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    if (dbPath !== ":memory:" && substituted.create_dirs !== false) {
      try { await mkdir(dirname(dbPath), { recursive: true }); } catch {}
    }
    try {
      const duck: any = await loadOptionalPkg("@duckdb/node-api");
      if (!duck) {
        return {
          ok: false,
          error: "duckdb: dépendance '@duckdb/node-api' non installée (npm i @duckdb/node-api).",
        };
      }
      const inst = await duck.DuckDBInstance.create(dbPath === ":memory:" ? ":memory:" : dbPath);
      const conn = await inst.connect();
      try {
        const reader = await conn.runAndReadAll(queryRaw, qparams);
        const rows = reader.getRowObjects();
        const isRead = /^\s*(?:select|with|pragma|describe|show)\b/i.test(queryRaw);
        return {
          ok: true,
          outputs: {
            rows: isRead ? rows : [],
            affected: isRead ? 0 : Number(rows?.length ?? 0),
            lastInsertRowid: 0,
          },
        };
      } finally {
        try { conn.disconnectSync?.(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `duckdb: ${e?.message || e}` };
    }
  }

  if (driver === "oracle") {
    const cs = String(substituted.connection_oracle || substituted.connection || "").trim();
    if (!cs) return { ok: false, error: "oracle: connection string requise" };
    try {
      const oracledb: any = await loadOptionalPkg("oracledb");
      if (!oracledb) {
        return {
          ok: false,
          error: "oracle: dépendance 'oracledb' non installée (npm i oracledb).",
        };
      }
      // Parse user/pass out of either oracle://user:pass@host:port/svc
      // or the legacy user/pass@host:port/svc TNS-shorthand. Else assume
      // the user provided a pre-built connectString and external auth.
      let user = "";
      let password = "";
      let connectString = cs;
      const urlMatch = cs.match(/^oracle(?:db)?:\/\/([^:]+):([^@]+)@(.+)$/i);
      if (urlMatch) {
        user = decodeURIComponent(urlMatch[1]);
        password = decodeURIComponent(urlMatch[2]);
        connectString = urlMatch[3];
      } else {
        const tnsMatch = cs.match(/^([^/]+)\/([^@]+)@(.+)$/);
        if (tnsMatch) {
          user = tnsMatch[1];
          password = tnsMatch[2];
          connectString = tnsMatch[3];
        }
      }
      // Oracle binds use :1, :2, … not ?. Rewrite for consistency with
      // SQLite/MySQL syntax that the user likely already has.
      let q = queryRaw;
      let bi = 1;
      q = q.replace(/\?/g, () => `:${bi++}`);
      const conn = await oracledb.getConnection({ user, password, connectString });
      try {
        const out = await conn.execute(q, qparams, {
          outFormat: oracledb.OUT_FORMAT_OBJECT,
          autoCommit: true,
        });
        const rows = (out as any).rows || [];
        const affected = Number((out as any).rowsAffected ?? 0);
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await conn.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `oracle: ${e?.message || e}` };
    }
  }

  if (driver === "mongodb") {
    const uri = String(substituted.connection_mongo || substituted.connection || "").trim();
    if (!uri) return { ok: false, error: "mongodb: URI requise" };
    const op = String(substituted.mongo_op || "find");
    const collection = String(substituted.mongo_collection || "").trim();
    if (!collection) return { ok: false, error: "mongodb: collection requise" };
    let payload: any = {};
    const payloadRaw = String(substituted.mongo_payload || "{}").trim();
    if (payloadRaw) {
      try { payload = JSON.parse(payloadRaw); }
      catch (e: any) { return { ok: false, error: `mongodb: payload invalide: ${e?.message}` }; }
    }
    try {
      const mongodb: any = await loadOptionalPkg("mongodb");
      if (!mongodb) {
        return { ok: false, error: "mongodb: dépendance 'mongodb' non installée (npm i mongodb)." };
      }
      const client = new mongodb.MongoClient(uri);
      try {
        await client.connect();
        let dbName = "";
        try { dbName = new URL(uri.replace(/^mongodb(\+srv)?:/, "http:")).pathname.replace(/^\//, ""); }
        catch { /* uri may not parse, fall through */ }
        if (!dbName) dbName = String(payload.db ?? "test");
        const col = client.db(dbName).collection(collection);
        let rows: unknown = [];
        let affected = 0;
        switch (op) {
          case "find":
            rows = await col.find(payload.filter ?? {}, payload.options ?? {}).toArray(); break;
          case "findOne":
            rows = [await col.findOne(payload.filter ?? {}, payload.options ?? {})]; break;
          case "insertOne": {
            const r = await col.insertOne(payload.doc ?? {});
            rows = [{ insertedId: r.insertedId }]; affected = r.acknowledged ? 1 : 0; break;
          }
          case "insertMany": {
            const r = await col.insertMany(payload.docs ?? []);
            rows = [{ insertedIds: r.insertedIds }]; affected = r.insertedCount ?? 0; break;
          }
          case "updateOne": {
            const r = await col.updateOne(payload.filter ?? {}, payload.update ?? {});
            rows = [{ matched: r.matchedCount, modified: r.modifiedCount }];
            affected = r.modifiedCount ?? 0; break;
          }
          case "updateMany": {
            const r = await col.updateMany(payload.filter ?? {}, payload.update ?? {});
            rows = [{ matched: r.matchedCount, modified: r.modifiedCount }];
            affected = r.modifiedCount ?? 0; break;
          }
          case "deleteOne": {
            const r = await col.deleteOne(payload.filter ?? {});
            rows = [{ deleted: r.deletedCount }]; affected = r.deletedCount ?? 0; break;
          }
          case "deleteMany": {
            const r = await col.deleteMany(payload.filter ?? {});
            rows = [{ deleted: r.deletedCount }]; affected = r.deletedCount ?? 0; break;
          }
          case "aggregate":
            rows = await col.aggregate(payload.pipeline ?? []).toArray(); break;
          case "countDocuments":
            rows = [{ count: await col.countDocuments(payload.filter ?? {}) }]; break;
          default:
            return { ok: false, error: `mongodb: opération inconnue "${op}"` };
        }
        return { ok: true, outputs: { rows, affected, lastInsertRowid: 0 } };
      } finally {
        try { await client.close(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `mongodb: ${e?.message || e}` };
    }
  }

  if (driver === "redis") {
    const url = String(substituted.connection_redis || substituted.connection || "").trim();
    if (!url) return { ok: false, error: "redis: URL requise" };
    let cmd: unknown[] = [];
    try {
      const raw = String(substituted.redis_command || "[]").trim();
      cmd = JSON.parse(raw);
      if (!Array.isArray(cmd) || cmd.length === 0) {
        return { ok: false, error: "redis: commande doit être un array JSON non vide" };
      }
    } catch (e: any) { return { ok: false, error: `redis: commande invalide: ${e?.message}` }; }
    try {
      const redis: any = await loadOptionalPkg("redis");
      if (!redis) {
        return { ok: false, error: "redis: dépendance 'redis' non installée (npm i redis)." };
      }
      const client = redis.createClient({ url });
      await client.connect();
      try {
        const reply = await client.sendCommand(cmd.map((x) => String(x)));
        return { ok: true, outputs: { rows: [reply], affected: 0, lastInsertRowid: 0 } };
      } finally {
        try { await client.quit(); } catch {}
      }
    } catch (e: any) {
      return { ok: false, error: `redis: ${e?.message || e}` };
    }
  }

  return { ok: false, error: `sql-query: driver inconnu "${driver}"` };
}
