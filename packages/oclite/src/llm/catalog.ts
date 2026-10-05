// opencode's cached models.dev catalog, read-only and never fetched: opencode.db `kv['models-dev:catalog']`, else
// the v1 `models.json` cache (OPENCODE_MODELS_PATH). bun:sqlite directly: core's DB layer costs ~0.4 s at startup (ADR).
import { Database } from "bun:sqlite"
import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Effect, Option, Schema } from "effect"

export type CatalogModel = {
  id?: string; reasoning?: boolean; limit?: { context?: number; output?: number }; cost?: { input?: number; output?: number }
  provider?: { npm?: string; api?: string }
}
export type CatalogProvider = { env?: string[]; npm?: string; api?: string; models: Record<string, CatalogModel> }

export const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/** `$XDG_DATA_HOME/opencode`, read at call time (tests point XDG_DATA_HOME at a fixture). */
export function opencodeDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
}

/** One query on opencode.db opened read-only; [] when the file or table is missing, locked or unreadable. */
export function opencodeDb<T>(sql: string, ...params: string[]): T[] {
  const file = path.join(opencodeDir(), "opencode.db")
  if (!existsSync(file)) return []
  const open = Effect.try({ try: () => new Database(file, { readonly: true }), catch: String })
  const query = (db: Database) => Effect.try({ try: () => db.query(sql).all(...params) as T[], catch: String })
  return Effect.runSync(Effect.acquireUseRelease(open, query, (db) => Effect.sync(() => db.close())).pipe(Effect.catch(() => Effect.succeed([] as T[]))))
}

export async function catalog() {
  const file = process.env.OPENCODE_MODELS_PATH ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "models.json")
  const row = opencodeDb<{ value: string }>("select value from kv where key = ?", "models-dev:catalog")[0]
  const body = Option.getOrUndefined(decodeJson(row?.value ?? "")) as { body?: unknown } | undefined
  const text = typeof body?.body === "string" ? body.body : existsSync(file) ? await Bun.file(file).text() : "{}"
  const value = Option.getOrElse(decodeJson(text), () => ({}))
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, CatalogProvider>
}
