import type { PrismaClient } from "@prisma/client";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { createTenantSqlRouter } from "../tenant-sql/router";

// Prisma remains only a compile-time contract for the existing callers. When
// tenant SQL is selected, the central Prisma module is never loaded.
export type DatabaseClient = Omit<PrismaClient, "$on" | "$extends">;
const database: DatabaseClient = tenantSqlEnabled()
	? createTenantSqlRouter() as DatabaseClient
	: (require("./central-prisma.service") as { default: DatabaseClient }).default;
export default database;
