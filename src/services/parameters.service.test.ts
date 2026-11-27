import assert from "node:assert/strict";
import type { Parameter, ParameterScope } from "@prisma/client";
import parametersService, { INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER } from "./parameters.service";
import { MESSAGE_FLOW_EDITOR_PARAMETER } from "../parameters/message-flow-editor";
import { CHANGELOG_CORRECTIONS_PARAMETER } from "../parameters/changelog-corrections";
import prismaService from "./prisma.service";
import { TRIAGE_FLAG } from "../parameters/triage-feature";
import { CONVERSATION_RECORDING_PARAMETER } from "../parameters/conversation-recording";
import { whatsappParameterSettings } from "../parameters/parameter-settings.catalog";

type FindManyArgs = { where?: { scope?: ParameterScope; instance?: string; userId?: number } };
type ParameterDelegate = {
	findMany(args?: FindManyArgs): Promise<Parameter[]>;
};

const parameterDelegate = prismaService.parameter as unknown as ParameterDelegate;
const originalFindMany = parameterDelegate.findMany.bind(parameterDelegate);

parameterDelegate.findMany = async ({ where }: FindManyArgs = {}) => {
	if (where?.instance === "tenant-recording") {
		const row: Parameter = { id: 1, instance: "tenant-recording", scope: "INSTANCE", userId: null, sectorId: null, key: CONVERSATION_RECORDING_PARAMETER, value: "true" };
		if (where.scope === "INSTANCE") return [row];
		if (where.scope === "USER" && where.userId === 9) return [{ ...row, scope: "USER", userId: 9 }];
		return [];
	}
	if (where?.instance === "tenant-flow") {
		const row: Parameter = { id: 1, instance: "tenant-flow", scope: "INSTANCE", userId: null, sectorId: null, key: MESSAGE_FLOW_EDITOR_PARAMETER, value: "false" };
		if (where.scope === "USER") return [{ ...row, scope: "USER", userId: 9, value: "true" }];
		if (where.scope === "INSTANCE") return [row, { ...row, id: 2, userId: 9, value: "true" }];
		return [];
	}
	if (where?.instance === "infotec" || where?.instance === "tenant-user-corrections") {
		const tenantEnabled = where.instance === "infotec";
		const row: Parameter = {
			id: 1,
			instance: where.instance,
			scope: "INSTANCE",
			userId: null,
			sectorId: tenantEnabled ? null : 11,
			key: CHANGELOG_CORRECTIONS_PARAMETER,
			value: "true"
		};
		if (where.scope === "INSTANCE") return [row];
		if (where.scope === "USER") {
			return [{ ...row, scope: "USER", userId: 9, sectorId: null, value: String(!tenantEnabled) }];
		}
		return [];
	}
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
		assert.deepEqual(whatsappParameterSettings.find(setting => setting.key === CONVERSATION_RECORDING_PARAMETER)?.supportedScopes, ["USER"]);
		assert.equal(await parametersService.canPlayConversationRecordings("tenant-recording", 9), true);
		assert.equal(await parametersService.canPlayConversationRecordings("tenant-recording", 10), false);
		assert.equal((await parametersService.getSessionParams({ instance: "tenant-recording", userId: 9 }))[CONVERSATION_RECORDING_PARAMETER], "true");
		assert.equal((await parametersService.getSessionParams({ instance: "tenant-recording", userId: 10 }))[CONVERSATION_RECORDING_PARAMETER], "false");
		assert.equal((await parametersService.getSessionParams({ instance: "tenant-flow", userId: 9 }))[MESSAGE_FLOW_EDITOR_PARAMETER], "false");
		assert.equal((await parametersService.getSessionParams({ instance: "infotec", userId: 9 }))[CHANGELOG_CORRECTIONS_PARAMETER], "true");
		assert.equal((await parametersService.getSessionParams({ instance: "tenant-user-corrections", userId: 9 }))[CHANGELOG_CORRECTIONS_PARAMETER], "false");
		assert.equal((await parametersService.getSessionParams({ instance: "tenant-default" }))[CHANGELOG_CORRECTIONS_PARAMETER], "false");
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

		const previous = ["INPULSE_ENVIRONMENT","TRIAGE_HOMOLOG_ENABLED","name"].map(key => [key, process.env[key]] as const);
		try {
			Object.assign(process.env,{INPULSE_ENVIRONMENT:"homolog",TRIAGE_HOMOLOG_ENABLED:"true",name:"homolog-whatsapp"});
			assert.equal((await parametersService.getSessionParams({instance:"tenant-default"}))[TRIAGE_FLAG],"true");
			process.env["name"]="whatsapp";
			assert.equal((await parametersService.getSessionParams({instance:"tenant-default"}))[TRIAGE_FLAG],"false");
		} finally {
			for (const [key,value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key]=value; }
		}
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
