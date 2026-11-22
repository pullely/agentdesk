import { DatabaseSync } from "node:sqlite";

// A DurableObjectState good enough for ThreadAgent under Node: storage.sql
// over node:sqlite (exec → cursor with toArray/one), alarms recorded.
export function fakeState() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      const isRead = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query);
      const rows = isRead ? (stmt.all(...(bindings as never[])) as Record<string, unknown>[]) : (stmt.run(...(bindings as never[])), []);
      return { toArray: () => rows, one: () => rows[0]! };
    },
  };
  const state = {
    storage: {
      sql,
      setAlarm: async (t: number) => {
        alarm = t;
      },
      getAlarm: async () => alarm,
      deleteAll: async () => {
        for (const t of ["messages", "turns", "meta"]) db.exec(`DELETE FROM ${t}`);
      },
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
  return { state, alarm: () => alarm, db };
}
