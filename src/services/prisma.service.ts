import { PrismaClient } from "@prisma/client";

const prismaService = new PrismaClient({
	datasources: {
		db: {
			url: process.env["WHATSAPP_DATABASE_URL"]
		}
	}
});

export default prismaService;


