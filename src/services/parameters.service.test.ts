import assert from "node:assert/strict";
import type { Parameter, ParameterScope } from "@prisma/client";
import parametersService, { INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER } from "./parameters.service";
import prismaService from "./prisma.service";

type FindManyArgs = { where?: { scope?: ParameterScope; instance?: string } };
type ParameterDelegate = {
	findMany(args?: FindManyArgs): Promise<Parameter[]>;
};

const parameterDelegate = prismaService.parameter as unknown as ParameterDelegate;
const originalFindMany = parameterDelegate.findMany.bind(parameterDelegate);

parameterDelegate.findMany = async ({ where }: FindManyArgs = {}) => {
	if (where?.scope !== "INSTANCE" || where.instance !== "tenant-enabled") {
		return [];
	}

	return [
		{
			id: 1,
			scope: "INSTANCE",
			instance: "tenant-enabled",
			sectorId: null,
			userId: null,
			key: INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER,
			value: "true"
		}
	];
};

async function run() {
	try {
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-default"), false);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-enabled"), true);
		assert.equal(
			(await parametersService.getSessionParams({ instance: "tenant-default" }))[
				INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER
			],
			"false"
		);
		assert.equal(
			(await parametersService.getSessionParams({ instance: "tenant-enabled" }))[
				INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER
			],
			"true"
		);

		console.log("Tenant parameter tests passed");
	} finally {
		parameterDelegate.findMany = originalFindMany;
		await prismaService.$disconnect();
	}
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
