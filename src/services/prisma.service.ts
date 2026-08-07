import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env["WHATSAPP_DATABASE_URL"];

const prismaService = databaseUrl
	? new PrismaClient({
		datasources: {
			db: {
				url: databaseUrl
			}
		}
	})
	: new PrismaClient();

export default prismaService;


