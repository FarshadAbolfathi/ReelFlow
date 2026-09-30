import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";

export type Db = PrismaClient;

let client: PrismaClient | undefined;

/** Creates (once per process) the Prisma client using the pg driver adapter. */
export function getDb(databaseUrl: string): PrismaClient {
  if (!client) {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}
