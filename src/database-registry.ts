import { resolve, join } from "node:path";
import { Store } from "./store.js";
import { openLearningDatabase } from "./learning-database.js";
import type { Mode, TradingMode } from "./domain.js";

/** Connections never retarget. Contexts retain these exact database objects. */
export class DatabaseRegistry {
  readonly learning;
  readonly demo: Store;
  readonly live: Store;
  private generation = 0;
  constructor(
    readonly directory: string,
    options: { initializeDemo?: boolean } = {},
  ) {
    const root = resolve(directory);
    this.learning = openLearningDatabase(join(root, "learning.sqlite"));
    let demo: Store | undefined;
    try {
      demo = this.demo = new Store(join(root, "demo.sqlite"), {
        mode: "demo",
        learningDb: this.learning,
        initializeDemo: options.initializeDemo,
      });
      this.live = new Store(join(root, "live.sqlite"), {
        mode: "live",
        learningDb: this.learning,
      });
    } catch (e) {
      demo?.close();
      this.learning.close();
      throw e;
    }
  }
  forMode(mode: Mode | TradingMode) {
    if (mode === "DEMO" || mode === "demo") return this.demo;
    if (mode === "LIVE" || mode === "live") return this.live;
    throw Error("LEGACY_PAPER_CONTEXT_FORBIDDEN");
  }
  context(mode: Mode | TradingMode) {
    const database = this.forMode(mode);
    return Object.freeze({
      mode: database.mode,
      database,
      generation: ++this.generation,
    });
  }
  close() {
    this.demo.close();
    this.live.close();
    this.learning.close();
  }
}
