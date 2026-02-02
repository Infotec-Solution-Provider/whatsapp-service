interface DatabaseContactRow {
	id: number;
	instance: string;
	name: string;
	phone: string;
	customer_id: number | null;
	is_deleted: boolean;
	customer_CODIGO: number | null;
	customer_RAZAO: string | null;
	customer_FANTASIA: string | null;
	customer_NOME: string | null;
	customer_CPF_CNPJ: string | null;
	customer_COD_ERP: string | null;
	customer_TELEFONE: string | null;
	customer_CELULAR: string | null;
	customer_EMAIL: string | null;
	operator_NOME: string | null;
	sector_ids: string | null;
}

interface MappedCustomer {
	CODIGO: number;
	RAZAO: string;
	FANTASIA: string;
	NOME: string;
	CPF_CNPJ: string;
	COD_ERP: string;
	TELEFONE: string;
	CELULAR: string;
	EMAIL: string;
}

interface MappedContact {
	id: number;
	instance: string;
	name: string;
	phone: string;
	customerId: number | null;
	isDeleted: boolean;
	sectors: Array<{ sectorId: number }>;
	customer: MappedCustomer | null;
	chatingWith: string | null;
}

/**
 * Mapper for transforming database rows into contact objects
 */
export class ContactMapper {
	/**
	 * Map a database row to a contact object
	 */
	public static mapDatabaseRow(row: DatabaseContactRow): MappedContact {
		const customer = this.mapCustomerData(row);
		const sectorIds = this.mapSectorIds(row.sector_ids);
		const chatingWith = row.operator_NOME || null;

		return {
			id: row.id,
			instance: row.instance,
			name: row.name,
			phone: row.phone,
			customerId: row.customer_id,
			isDeleted: row.is_deleted,
			sectors: sectorIds.map((sectorId) => ({ sectorId })),
			customer,
			chatingWith
		};
	}

	/**
	 * Map customer data from database row
	 */
	public static mapCustomerData(row: DatabaseContactRow): MappedCustomer | null {
		if (row.customer_CODIGO === null) {
			return null;
		}

		return {
			CODIGO: row.customer_CODIGO,
			RAZAO: row.customer_RAZAO || "",
			FANTASIA: row.customer_FANTASIA || "",
			NOME: row.customer_NOME || "",
			CPF_CNPJ: row.customer_CPF_CNPJ || "",
			COD_ERP: row.customer_COD_ERP || "",
			TELEFONE: row.customer_TELEFONE || "",
			CELULAR: row.customer_CELULAR || "",
			EMAIL: row.customer_EMAIL || ""
		};
	}

	/**
	 * Parse sector IDs from GROUP_CONCAT result
	 */
	public static mapSectorIds(sectorIdsString: string | null): number[] {
		if (!sectorIdsString || typeof sectorIdsString !== "string") {
			return [];
		}

		return sectorIdsString
			.split(",")
			.map((id) => parseInt(id, 10))
			.filter((id) => !isNaN(id));
	}
}
