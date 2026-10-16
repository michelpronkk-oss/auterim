type SnapshotDatabase = {
  clone(): Promise<unknown>;
  close(): Promise<void>;
};

function recordTiming(label: string, stage: string, startedAt: number) {
  if (process.env.AUTERIM_PROFILE_PGLITE_SETUP !== "1") return;
  console.info(
    `PGLITE_SETUP_TIMING suite=${label} stage=${stage} duration_ms=${Math.round(performance.now() - startedAt)}`,
  );
}

export async function measurePGliteSetup<T>(
  label: string,
  stage: string,
  operation: () => Promise<T>,
) {
  const startedAt = performance.now();
  const value = await operation();
  recordTiming(label, stage, startedAt);
  return value;
}

export function createPGliteSnapshotFactory<T extends SnapshotDatabase>(label: string) {
  const templates = new Map<string, Promise<T>>();
  const openClones = new Set<T>();

  return {
    async create(key: string, initialize: () => Promise<T>) {
      let templatePromise = templates.get(key);
      if (!templatePromise) {
        templatePromise = initialize();
        templates.set(key, templatePromise);
      }

      const template = await templatePromise;
      const cloneStartedAt = performance.now();
      const database = (await template.clone()) as T;
      recordTiming(label, "clone", cloneStartedAt);

      let closed = false;
      const close = database.close.bind(database);
      database.close = async () => {
        if (closed) return;
        closed = true;
        openClones.delete(database);
        const teardownStartedAt = performance.now();
        await close();
        recordTiming(label, "clone_teardown", teardownStartedAt);
      };
      openClones.add(database);
      return database;
    },

    async close() {
      await Promise.all([...openClones].map((database) => database.close()));
      const templateDatabases = await Promise.all(templates.values());
      await Promise.all(templateDatabases.map((database) => database.close()));
      templates.clear();
    },
  };
}
