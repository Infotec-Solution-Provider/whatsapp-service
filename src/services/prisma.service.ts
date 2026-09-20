import { Prisma, PrismaClient } from "@prisma/client";
import { recordDatabaseIncident } from "../utils/database-incident-log";
import { startDatabaseIncidentCapture } from "../utils/database-incident-capture";
import { databaseOperationExtension } from "../utils/database-operation-extension";

const databaseUrl = process.env["WHATSAPP_DATABASE_URL"];
const prismaLog = [{ emit: "event", level: "error" }] as [{ emit: "event"; level: "error" }];
type PrismaEventOptions = Prisma.PrismaClientOptions & { log: typeof prismaLog };

const options: PrismaEventOptions = databaseUrl
	? {
		log: prismaLog,
		datasources: {
			db: {
				url: databaseUrl
			}
		}
	}
	: { log: prismaLog };
const prismaClient = new PrismaClient<PrismaEventOptions>(options);
startDatabaseIncidentCapture();

// This listener runs even when the caller catches the Prisma exception and
// the normal ProcessLog write cannot reach MySQL.
prismaClient.$on("error", (event) => {
	recordDatabaseIncident(event, { source: "prisma-engine", operation: event.target });
});

// Extended clients omit event registration; listeners belong to the base client.
export type DatabaseClient = Omit<PrismaClient, "$on" | "$extends">;
// This query-only extension forwards args/results unchanged, including the
// transaction context. Prisma's dynamic extension type uses different generic
// transaction signatures; keep the existing, unmodified delegate contract.
const prismaService = prismaClient.$extends(databaseOperationExtension()) as unknown as DatabaseClient;

export default prismaService;


