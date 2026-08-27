import prismaService from "./prisma.service";

const DEFAULT_FEATURE_PARAMETERS: Record<string, string> = {
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
	feature_frontend_performance_telemetry_enabled: "false",
	feature_perf_paginated_chat_history_enabled: "false",
	feature_perf_stable_socket_listeners_enabled: "false",
	feature_perf_virtualized_chat_list_enabled: "false",
	feature_whatsapp_session_monitoring_enabled: "false",
	feature_internal_group_whatsapp_sync_enabled: "false"
};

export const INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER = "feature_internal_group_whatsapp_sync_enabled";

export const CONTACT_APPROVAL_PARAMETERS = {
	reactivation: "require_supervisor_approval_for_contact_reactivation",
	deletion: "require_supervisor_approval_for_contact_deletion"
} as const;

class ParametersService {
	public async getUserParams(instance: string, userId: number) {
		const userParams = await prismaService.parameter.findMany({
			where: {
				scope: "USER",
				instance,
				userId
			}
		});

		return userParams;
	}

	public async getSectorParams(sectorId: number) {
		const sectorParams = await prismaService.parameter.findMany({
			where: {
				scope: "SECTOR",
				sectorId
			}
		});

		return sectorParams;
	}

	public async getInstanceParams(instance: string) {
		const instanceParams = await prismaService.parameter.findMany({
			where: { instance, scope: "INSTANCE" }
		});

		return instanceParams;
	}

	public async getInstanceBooleanParam(instance: string, key: string, defaultValue = false) {
		const params = await this.getInstanceParams(instance);
		const value = params.find((parameter) => parameter.key === key)?.value;
		if (value === "true") return true;
		if (value === "false") return false;
		return defaultValue;
	}

	public async isInternalGroupWhatsappSyncEnabled(instance: string) {
		return this.getInstanceBooleanParam(instance, INTERNAL_GROUP_WHATSAPP_SYNC_PARAMETER, false);
	}

	public async getSessionParams({
		instance,
		sectorId,
		userId
	}: {
		instance: string;
		sectorId?: number | null;
		userId?: number | null;
	}) {
		const [instanceParams, sectorParams, userParams] = await Promise.all([
			this.getInstanceParams(instance),
			sectorId ? this.getSectorParams(sectorId) : [],
			userId ? this.getUserParams(instance, userId) : []
		]);

		// helper para transformar array em objeto
		const toParamMap = (params: { key: string; value: string }[]) =>
			Object.fromEntries(params.map((p) => [p.key, p.value]));

		// prioridade: instancia < setor < usuario
		const mergedParams = {
			...DEFAULT_FEATURE_PARAMETERS,
			...toParamMap(instanceParams),
			...toParamMap(sectorParams),
			...toParamMap(userParams)
		};

		return mergedParams;
	}
}

export default new ParametersService();
