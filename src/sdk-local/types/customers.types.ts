export interface Customer {
	CODIGO: number;
	RAZAO: string;
	FANTASIA: string | null;
	PESSOA: "FIS" | "JUR" | null;
	ATIVO: "SIM" | "NAO" | null;
	CPF_CNPJ: string | null;
	IE_RG: string | null;
	GRUPO: number | null;
	END_RUA: string | null;
	CIDADE: string | null;
	BAIRRO: string | null;
	ESTADO: string | null;
	CEP: string | null;
	COMPLEMENTO: string | null;
	AREA1: number | null;
	AREA2: number | null;
	AREA3: number | null;
	AREAFAX: number | null;
	FONE1: string | null;
	FONE2: string | null;
	FONE3: string | null;
	FAX: string | null;
	DESC_FONE1: string | null;
	DESC_FONE2: string | null;
	DESC_FONE3: string | null;
	DESCFAX: string | null;
	EMAIL: string | null;
	WEBSITE: string | null;
	DATACAD: string | null;
	STATUS_CAD: string | null;
	OBS_ADMIN: string | null;
	OBS_OPERADOR: string | null;
	ORIGEM: number | null;
	OPERADOR: number | null;
	COD_MIDIA: number | null;
	COD_ERP: string | null;
	BLOCK_COMPRAS: "SIM" | "NAO" | null;
	COD_UNIDADE: number | null;
	SALDO_DISPONIVEL: number | null;
	SALDO_LIMITE: number | null;
	POTENCIAL: number | null;
	DATA_ULT_COMPRA: string | null;
	SEGMENTO: number | null;
	ULTI_RESULTADO: string | null;
	DT_AGENDAMENTO: string | null;
	COD_CAMPANHA: number | null;
	COD_RESULTADO: number | null;
	CONTATO_MAIL: string | null;
	ATUALIZADOR: "CADASTRO" | "ATUALIZAÇÃO" | null;
	OPERADOR_LOGIN: string | null;
	OBS_FONE1: string | null;
	OBS_FONE2: string | null;
	OBS_FONE3: string | null;
	NR_FUNCIONARIOS: number | null;
	EMAIL2: string | null;
	OBS_CLIENTES: string | null;
	VENCIMENTO_LIMITE_CREDITO: string | null;
	PERIODO_RECOMPRA: number;
	DT_ULTIMO_ORCAMENTO_VENDA: string | null;
	POSSUI_ORCAMENTO: "S" | "N" | null;
	POSSUI_VENDA: "S" | "N" | null;
	CODIGOPRINCIPAL: number | null;
	SETOR: number | null;
}

export interface CreateCustomerDTO {
	RAZAO: string;
	CPF_CNPJ?: string | null;
	FANTASIA?: string | null;
	PESSOA?: "FIS" | "JUR" | null;
	ATIVO?: "SIM" | "NAO" | null;
	CIDADE?: string | null;
	ESTADO?: string | null;
	COD_ERP?: string | null;
	SETOR?: number | null;
}
export type UpdateCustomerDTO = Partial<CreateCustomerDTO>;

export interface CustomerLookupOption {
	CODIGO: number;
	NOME: string | null;
}

export interface CustomerContactDetail {
	CODIGO: string;
	NOME: string;
	CARGO: number | null;
	EMAIL: string | null;
	AREA_DIRETO: string | null;
	AREA_CEL: string | null;
	AREA_RESI: string | null;
	FONE_DIRETO: string | null;
	CELULAR: string | null;
	FONE_RESIDENCIAL: string | null;
	ANIVERSARIO: string | null;
	TIME_FUTEBOL: string | null;
	SEXO: "M" | "F" | null;
	FILHOS: number;
	CLIENTE: number | null;
	TRATAMENTO: string | null;
}

export interface CustomerPurchaseItemDetail {
	purchaseCode: number;
	productCode: string | null;
	description: string | null;
	quantity: number | null;
	unit: string | null;
	unitValue: number | null;
	discount: number | null;
}

export interface CustomerPurchaseDetail {
	CODIGO: number;
	CLIENTE: number;
	DATA: string;
	VALOR: number;
	DESCRICAO: string | null;
	FORMA_PGTO: string | null;
	OPERADOR: number | null;
	FATURADO: "S" | "N" | null;
	TIPO: string | null;
	SITUACAO: "F" | "C" | null;
	CLIENTEATIVO: number | null;
	items: CustomerPurchaseItemDetail[];
}

export interface CustomerScheduleDetail {
	CODIGO: number;
	CLIENTE: number;
	CAMPANHA: number;
	DT_RESULTADO: string;
	DT_AGENDAMENTO: string;
	RESULTADO: number;
	CONCLUIDO: "SIM" | "NAO" | null;
	FONE1: string;
	FONE2: string;
	FONE3: string;
	ORDEM: number;
	OPERADOR: number;
	OPERADOR_LIGACAO: number;
	DATA_HORA_LIG: string;
	DATA_HORA_FIM: string;
	TELEFONE_LIGADO: string;
	AGENDA: number;
	DESC_FONE1: string | null;
	DESC_FONE2: string | null;
	DESC_FONE3: string | null;
	FIDELIZA: "S" | "N" | null;
	MANUAL: "S" | "N" | null;
}

export interface CustomerTelephonySchedule extends CustomerScheduleDetail {
	CAMPANHA_NOME: string | null;
	OPERADOR_NOME: string | null;
	OPERADOR_LIGACAO_NOME: string | null;
	CLIENTE_RAZAO: string | null;
	CLIENTE_FANTASIA: string | null;
}

export interface FinishTelephonyScheduleDTO {
	resultId: number;
	scheduleDate?: string;
	startedAt?: string;
	finishedAt?: string;
	dialedPhone?: string;
}

export interface CustomerCallHistoryDetail {
	CODIGO: number;
	OPERADOR: number;
	CLIENTE: number;
	RESULTADO: number;
	EXCEDEU: "SIM" | "NAO" | null;
	TEMPO_EXCEDIDO: string;
	FONE_RECEPTIVO: string;
	LIGACAO_RECEBIDA: string;
	LIGACAO_FINALIZADA: string;
	TIPO_ACAO: string;
	OBS: string | null;
}

export interface CustomerFullDetail {
	customer: Customer;
	campaign: {
		fullName: string | null;
		firstName: string | null;
	};
	wallet: {
		fullName: string | null;
		firstName: string | null;
	};
	address: {
		END_RUA: string | null;
		CIDADE: string | null;
		BAIRRO: string | null;
		ESTADO: string | null;
		CEP: string | null;
		COMPLEMENTO: string | null;
	};
	origin: {
		group: { code: number | null; description: string | null };
		origin: { code: number | null; description: string | null };
		media: { code: number | null; name: string | null };
		operator: { code: number | null; name: string | null };
		segment: { code: number | null; name: string | null };
		emails: {
			EMAIL: string | null;
			EMAIL2: string | null;
			CONTATO_MAIL: string | null;
		};
		WEBSITE: string | null;
		NR_FUNCIONARIOS: number | null;
		customName: string | null;
	};
	contacts: CustomerContactDetail[];
	observations: {
		OBS_ADMIN: string | null;
		OBS_OPERADOR: string | null;
	};
	callHistory: CustomerCallHistoryDetail[];
	phones: {
		AREA1: number | null;
		FONE1: string | null;
		DESC_FONE1: string | null;
		AREA2: number | null;
		FONE2: string | null;
		DESC_FONE2: string | null;
		AREA3: number | null;
		FONE3: string | null;
		DESC_FONE3: string | null;
		AREAFAX: number | null;
		FAX: string | null;
		DESCFAX: string | null;
		campaignPhones: Array<{
			area: number | null;
			phone: string | null;
			description: string | null;
		}>;
	};
	purchases: CustomerPurchaseDetail[];
	schedules: CustomerScheduleDetail[];
	metadata: {
		editableTabs: {
			main: boolean;
			address: boolean;
			contacts: boolean;
			observations: boolean;
			phones: boolean;
		};
		purchaseItems: {
			mapped: boolean;
			tableName: string | null;
		};
		customNameFieldMapped: boolean;
	};
}
