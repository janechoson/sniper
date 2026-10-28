import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Repository } from "@sniper/storage";
import type { DiscoveryCursorStore } from "./evm-discovery";
const cursor = z.object({ key: z.string(), value: z.string() });
export class JournalCursorStore implements DiscoveryCursorStore {
  private values = new Map<string, string>();
  constructor(private readonly repository: Repository) {}
  async restore() {
    for (const row of await this.repository.read())
      if (row.kind === "discovery.cursor") {
        const value = cursor.parse(row.payload);
        this.values.set(value.key, value.value);
      }
  }
  async readCursor(key: string) {
    return this.values.get(key);
  }
  async writeCursor(key: string, value: string) {
    if (this.values.get(key) === value) return;
    await this.repository.append({
      id: randomUUID(),
      kind: "discovery.cursor",
      payload: { key, value },
      createdAt: Date.now(),
    });
    this.values.set(key, value);
  }
}
