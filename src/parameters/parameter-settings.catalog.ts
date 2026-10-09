export interface ParameterSetting {
	key: string;
	label: string;
	description: string;
	group: string;
	type: "boolean" | "number";
	defaultValue: string | null;
	trueValue?: string;
	falseValue?: string;
	unit?: string;
	multiplier?: number;
	min?: number;
	max?: number;
}

function toggle(
	key: string,
	label: string,
	description: string,
	group: string,
	defaultValue: string | null = "false"
): ParameterSetting {
	return { key, label, description, group, type: "boolean", defaultValue, trueValue: "true", falseValue: "false" };
}

// Explicit catalog: adding a supported setting here automatically adds its control to the frontend.
// Provider identity/credentials and experimental tuning are deliberately not editable here.
export const whatsappParameterSettings: ParameterSetting[] = [
	toggle(
		"require_supervisor_approval_for_contact_reactivation",
		"Aprovar reativação de contatos",
		"Solicitar aprovação de um supervisor antes de reativar contatos.",
		"Contatos"
	),
	toggle(
		"require_supervisor_approval_for_contact_deletion",
		"Aprovar exclusão de contatos",
		"Solicitar aprovação de um supervisor antes de excluir contatos.",
		"Contatos"
	),
	toggle(
		"customer_detail_modal_enabled",
		"Detalhes do cliente",
		"Exibir os detalhes do cliente ao iniciar um atendimento.",
		"Contatos"
	),
	toggle(
		"customer_detail_edit_enabled",
		"Editar dados do cliente",
		"Permitir editar os dados do cliente na janela de detalhes.",
		"Contatos"
	),
	toggle(
		"update_only_own_contacts",
		"Editar apenas contatos próprios",
		"Restringir operadores à edição dos seus próprios contatos. Administradores mantêm o acesso.",
		"Contatos"
	),
	toggle(
		"customer_linking_bot_enabled",
		"Vincular clientes automaticamente",
		"Habilitar o bot de vinculação de clientes aos contatos.",
		"Contatos"
	),
	toggle(
		"disable_contacts_crud",
		"Bloquear cadastro de contatos",
		"Ocultar o cadastro de contatos no menu.",
		"Contatos"
	),
	toggle(
		"disable_internal_chats",
		"Bloquear conversas internas",
		"Bloquear o acesso às conversas internas.",
		"Conversas"
	),
	toggle(
		"disable_internal_groups",
		"Bloquear grupos internos",
		"Bloquear o acesso aos grupos internos.",
		"Conversas"
	),
	toggle(
		"disable_channel_switch",
		"Bloquear troca de canal",
		"Impedir que o operador altere o canal do atendimento.",
		"Conversas"
	),
	toggle(
		"start_chats_as_admin",
		"Iniciar atendimentos como administrador",
		"Aplicar o comportamento administrativo ao iniciar atendimentos.",
		"Conversas"
	),
	toggle(
		"feature_chat_export_enabled",
		"Exportar conversas",
		"Disponibilizar a exportação de conversas.",
		"Conversas",
		"true"
	),
	toggle(
		"feature_internal_group_whatsapp_sync_enabled",
		"Sincronizar grupos internos com WhatsApp",
		"Controlar o encaminhamento de mensagens entre grupos internos e WhatsApp. O padrão depende do provedor.",
		"Conversas",
		null
	),
	toggle(
		"chat_auto_finish_enabled",
		"Finalizar atendimentos por inatividade",
		"Finalizar automaticamente atendimentos sem interação, conforme a rotina de inatividade.",
		"Atendimento"
	),
	{
		key: "chat_auto_finish_idle_time",
		label: "Tempo de inatividade",
		description: "Tempo sem interação antes da finalização automática.",
		group: "Atendimento",
		type: "number",
		defaultValue: "1800000",
		unit: "minutos",
		multiplier: 60000,
		min: 1,
		max: 10080
	},
	toggle(
		"feature_whatsapp_session_monitoring_enabled",
		"Monitorar sessões WhatsApp",
		"Disponibilizar o monitoramento operacional das sessões WhatsApp.",
		"Atendimento"
	),
	toggle(
		"feature_mass_messages_enabled",
		"Mensagens em massa",
		"Disponibilizar a ferramenta de mensagens em massa.",
		"Recursos"
	),
	toggle(
		"feature_customer_profile_tags_enabled",
		"Classificação de clientes",
		"Disponibilizar as classificações do perfil do cliente.",
		"Recursos"
	),
	toggle("feature_funnels_enabled", "Funis", "Disponibilizar os funis de atendimento e vendas.", "Recursos"),
	toggle(
		"feature_ai_enabled",
		"Inteligência artificial",
		"Habilitar os recursos de IA. As opções abaixo também precisam ser ativadas para aparecerem.",
		"Inteligência artificial"
	),
	toggle(
		"feature_ai_agents_enabled",
		"Agentes de IA",
		"Disponibilizar agentes de IA quando a inteligência artificial estiver habilitada.",
		"Inteligência artificial"
	),
	toggle(
		"feature_ai_supervisor_enabled",
		"Assistente de IA",
		"Disponibilizar o assistente quando a inteligência artificial estiver habilitada.",
		"Inteligência artificial"
	),
	toggle(
		"feature_ai_settings_enabled",
		"Configurações de IA",
		"Disponibilizar as configurações quando a inteligência artificial estiver habilitada.",
		"Inteligência artificial"
	),
	toggle(
		"feature_reports_advanced_enabled",
		"Relatórios avançados",
		"Disponibilizar relatórios avançados de operadores, metas e qualidade.",
		"Relatórios"
	),
	toggle(
		"feature_reports_dashboards_enabled",
		"Dashboards de relatórios",
		"Habilitar o parâmetro de dashboards para os consumidores que o utilizam.",
		"Relatórios"
	),
	toggle(
		"feature_sales_reports_enabled",
		"Relatórios de vendas",
		"Disponibilizar relatórios de vendas e desempenho.",
		"Relatórios"
	),
	toggle(
		"feature_sip_config_enabled",
		"Configuração SIP",
		"Disponibilizar a tela de configuração SIP para administradores.",
		"Telefonia"
	),
	toggle(
		"feature_telephony_dialer_enabled",
		"Discador de telefonia",
		"Disponibilizar o discador. A conexão com a central também deve estar configurada.",
		"Telefonia"
	),
	toggle(
		"use_local_contacts_sync",
		"Sincronizar contatos com o CRM legado",
		"Utilizar a sincronização local de contatos quando a integração estiver configurada.",
		"Integrações"
	),
	toggle(
		"use_old_crm_schedule",
		"Utilizar agenda do CRM legado",
		"Consultar os agendamentos do CRM legado pela integração de agendas.",
		"Integrações"
	)
];
