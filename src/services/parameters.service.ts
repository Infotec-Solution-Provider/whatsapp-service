import prismaService from "./prisma.service";

const DEFAULT_FEATURE_PARAMETERS: Record<string, string> = {
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
	feature_whatsapp_session_monitoring_enabled: "false"
};

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
