import prismaService from "./prisma.service";
import { TRANSFER_FROM_CONTACT_SEARCH } from "../parameters/transfer-from-contact-search";
import { META_MANAGEMENT_PARAMETER } from "../parameters/meta-management";
import { MESSAGE_FLOW_EDITOR_PARAMETER } from "../parameters/message-flow-editor";
import { CHANGELOG_CORRECTIONS_PARAMETER } from "../parameters/changelog-corrections";
import { homologTriageEnabled, resolveTriageFlag, TRIAGE_FLAG } from "../parameters/triage-feature";
import { CONVERSATION_RECORDING_PARAMETER } from "../parameters/conversation-recording";

const DEFAULT_FEATURE_PARAMETERS: Record<string, string> = {
	"monitor:wait_warning_minutes": "30",
	"monitor:wait_critical_minutes": "1440",
	require_supervisor_approval_for_contact_reactivation: "false",
	require_supervisor_approval_for_contact_deletion: "false",
	feature_ai_enabled: "false",
	feature_ai_agents_enabled: "false",
	feature_ai_supervisor_enabled: "false",
	feature_ai_settings_enabled: "false",
	feature_customer_profile_tags_enabled: "false",
	feature_funnels_enabled: "false",
	feature_mass_messages_enabled: "false",
	feature_reports_advanced_enabled: "false",
	feature_reports_dashboards_enabled: "false",
	feature_chat_export_enabled: "true",
	feature_sales_reports_enabled: "false",
	feature_sip_config_enabled: "false",
	feature_telephony_dialer_enabled: "false",
	feature_perf_paginated_chat_history_enabled: "false",
	feature_perf_stable_socket_listeners_enabled: "false",
	feature_perf_virtualized_chat_list_enabled: "false",
	feature_whatsapp_session_monitoring_enabled: "false"
};

// This key intentionally has no universal default above: legacy Remote/parsed
// ingestion is opt-out, while WWEBJS/internal forwarding is opt-in.
export const INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER = "feature_internal_group_whatsapp_sync_enabled";

export const CONTACT_APPROVAL_PARAMETERS = {
	reactivation: "require_supervisor_approval_for_contact_reactivation",
	deletion: "require_supervisor_approval_for_contact_deletion"
} as const;

function userPermissionEnabled(parameters: { key: string; sectorId: number | null; value: string }[], key: string) {
	return parameters.filter(parameter => parameter.key === key && parameter.sectorId === null)
		.at(-1)?.value === "true";
}

class ParametersService {
	public async getUserParams(instance: string, userId: number) {
		const userParams = await prismaService.parameter.findMany({
			where: {
				scope: "USER",
				instance,
				userId
			},
			orderBy: { id: "asc" }
		});

		return userParams;
	}

	public async getSectorParams(instance: string, sectorId: number) {
		// Older sector rows have no instance. Only accept them for a sector owned by this tenant.
		const sector = await prismaService.wppSector.findFirst({
			where: { id: sectorId, instance },
			select: { id: true }
		});
		if (!sector) return [];
		const sectorParams = await prismaService.parameter.findMany({
			where: {
				scope: "SECTOR",
				sectorId,
				userId: null,
				OR: [{ instance }, { instance: null }]
			},
			orderBy: { id: "asc" }
		});

		return sectorParams;
	}

	public async getInstanceParams(instance: string) {
		const instanceParams = await prismaService.parameter.findMany({
			where: { instance, scope: "INSTANCE" },
			orderBy: { id: "asc" }
		});

		return instanceParams;
	}

	public async getInstanceBooleanParam(instance: string, key: string, defaultValue = false) {
		const params = await this.getInstanceParams(instance);
		const value = params.filter((parameter) => parameter.key === key).at(-1)?.value;
		if (value === "true") return true;
		if (value === "false") return false;
		return defaultValue;
	}

	public async canPlayConversationRecordings(instance: string, userId: number) {
		return userPermissionEnabled(await this.getUserParams(instance, userId), CONVERSATION_RECORDING_PARAMETER);
	}

	public async canTransferFromContactSearch(instance: string, userId: number) {
		if (userId <= 0) return false;
		return userPermissionEnabled(await this.getUserParams(instance, userId), TRANSFER_FROM_CONTACT_SEARCH);
	}

	public async isInternalGroupWhatsappSyncEnabled(instance: string, legacyDefault: boolean) {
		return this.getInstanceBooleanParam(instance, INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER, legacyDefault);
	}

	public async isMetaManagementEnabled(instance: string) {
		return this.isInstanceFeatureEnabled(instance, META_MANAGEMENT_PARAMETER);
	}

	public async isMessageFlowEditorEnabled(instance: string) {
		if (homologTriageEnabled()) return true;
		return this.isInstanceFeatureEnabled(instance, MESSAGE_FLOW_EDITOR_PARAMETER);
	}

	private async isInstanceFeatureEnabled(instance: string, key: string) {
		const parameter = await prismaService.parameter.findFirst({
			where: { instance, scope: "INSTANCE", key, userId: null, sectorId: null },
			orderBy: { id: "desc" },
			select: { value: true }
		});
		return parameter?.value === "true";
	}

	public async getSessionParams({
		instance,
		sectorId,
		userId
	}: {
		instance: string;
		sectorId?: number | null;
		userId?: number | null;
	}): Promise<Record<string, string>> {
		const [instanceParams, sectorParams, userParams] = await Promise.all([
			this.getInstanceParams(instance),
			sectorId ? this.getSectorParams(instance, sectorId) : [],
			userId ? this.getUserParams(instance, userId) : []
		]);

		// helper para transformar array em objeto
		const toParamMap = (params: { key: string; value: string }[]) =>
			Object.fromEntries(params.map((p) => [p.key, p.value]));

		// prioridade: instancia < setor < usuario
		const instanceFlags = toParamMap(instanceParams.filter(row => row.userId === null && row.sectorId === null));
		const mergedParams = {
			...DEFAULT_FEATURE_PARAMETERS,
			...toParamMap(instanceParams),
			...toParamMap(sectorParams),
			...toParamMap(userParams),
			[CONVERSATION_RECORDING_PARAMETER]: String(userPermissionEnabled(userParams, CONVERSATION_RECORDING_PARAMETER)),
			[TRANSFER_FROM_CONTACT_SEARCH]: String(userPermissionEnabled(userParams, TRANSFER_FROM_CONTACT_SEARCH)),
			[META_MANAGEMENT_PARAMETER]: String(instanceFlags[META_MANAGEMENT_PARAMETER] === "true"),
			[CHANGELOG_CORRECTIONS_PARAMETER]: String(instanceFlags[CHANGELOG_CORRECTIONS_PARAMETER] === "true"),
			[MESSAGE_FLOW_EDITOR_PARAMETER]: String(homologTriageEnabled() || instanceFlags[MESSAGE_FLOW_EDITOR_PARAMETER] === "true"),
			[TRIAGE_FLAG]: String(resolveTriageFlag(instanceFlags[TRIAGE_FLAG]))
		};

		return mergedParams;
	}
}

export default new ParametersService();
