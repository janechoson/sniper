import { resolve, join } from "node:path";
import { Store } from "./store.js";
import { openLearningDatabase } from "./learning-database.js";
/** Connections never retarget. Contexts retain these exact database objects. */
export class DatabaseRegistry {
    directory;
    learning;
    demo;
    live;
    generation = 0;
    constructor(directory, options = {}) {
        this.directory = directory;
        const root = resolve(directory);
        this.learning = openLearningDatabase(join(root, "learning.sqlite"));
        let demo;
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
        }
        catch (e) {
            demo?.close();
            this.learning.close();
            throw e;
        }
    }
    forMode(mode) {
        if (mode === "DEMO" || mode === "demo")
            return this.demo;
        if (mode === "LIVE" || mode === "live")
            return this.live;
        throw Error("LEGACY_PAPER_CONTEXT_FORBIDDEN");
    }
    context(mode) {
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
