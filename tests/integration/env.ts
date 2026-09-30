export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://reelflow:reelflow_dev_password@127.0.0.1:5434/reelflow_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6380/1";
