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
	if (where?.scope !== "INSTANCE") {
		return [];
	}

	if (where.instance === "tenant-disabled") {
		return [
			{
				id: 2,
				scope: "INSTANCE",
				instance: "tenant-disabled",
				sectorId: null,
				userId: null,
				key: INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER,
				value: "false"
			}
		];
	}

	if (where.instance === "tenant-invalid") {
		return [
			{
				id: 3,
				scope: "INSTANCE",
				instance: "tenant-invalid",
				sectorId: null,
				userId: null,
				key: INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER,
				value: "invalid"
			}
		];
	}

	if (where.instance !== "tenant-enabled") return [];

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
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-default", false), false);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-default", true), true);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-enabled", false), true);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-disabled", true), false);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-invalid", true), true);
		assert.equal(await parametersService.isInternalGroupWhatsappSyncEnabled("tenant-invalid", false), false);
		assert.equal(
			(await parametersService.getSessionParams({ instance: "tenant-default" }))[
				INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER
			],
			undefined
		);
		assert.equal(
			(await parametersService.getSessionParams({ instance: "tenant-enabled" }))[
				INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER
			],
			"true"
		);
		assert.equal(
			(await parametersService.getSessionParams({ instance: "tenant-disabled" }))[
				INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER
			],
			"false"
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
