import { Prisma, PrismaClient } from "@prisma/client";
import { recordDatabaseIncident } from "../utils/database-incident-log";
import { startDatabaseIncidentCapture } from "../utils/database-incident-capture";

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
const prismaService = new PrismaClient<PrismaEventOptions>(options);
startDatabaseIncidentCapture();

// This listener runs even when the caller catches the Prisma exception and
// the normal ProcessLog write cannot reach MySQL.
prismaService.$on("error", (event) => {
	recordDatabaseIncident(event, { source: "prisma-engine", operation: event.target });
});

export default prismaService;


