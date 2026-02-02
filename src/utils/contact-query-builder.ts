import { ContactsFilters } from "../services/contacts.service";

interface WhereConditionsResult {
	conditions: string[];
	params: any[];
}

/**
 * Query builder for contact queries with filters
 */
export class ContactQueryBuilder {
	/**
	 * Build WHERE conditions for contact filters
	 */
	public static buildWhereConditions(filters: ContactsFilters): WhereConditionsResult {
		const queryParams: any[] = [];
		const whereConditions: string[] = ["ctt.is_deleted = false"];

		// Contact filters
		if (filters.name) {
			whereConditions.push("ctt.name LIKE ?");
			queryParams.push(`%${filters.name}%`);
		}

		if (filters.phone) {
			const phoneDigits = filters.phone.replace(/\D/g, "");
			if (phoneDigits) {
				whereConditions.push("ctt.phone LIKE ?");
				queryParams.push(`%${phoneDigits}%`);
			}
		}

		if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
			whereConditions.push("ctt.customer_id = ?");
			queryParams.push(filters.customerId);
		}

		if (filters.hasCustomer === true) {
			whereConditions.push("ctt.customer_id IS NOT NULL");
		} else if (filters.hasCustomer === false) {
			whereConditions.push("ctt.customer_id IS NULL");
		}

		// Customer filters
		if (filters.customerErp) {
			whereConditions.push("cli.COD_ERP LIKE ?");
			queryParams.push(`%${filters.customerErp}%`);
		}

		if (filters.customerCnpj) {
			whereConditions.push("cli.CPF_CNPJ LIKE ?");
			queryParams.push(`%${filters.customerCnpj}%`);
		}

		if (filters.customerName) {
			whereConditions.push("(cli.RAZAO LIKE ? OR cli.FANTASIA LIKE ?)");
			queryParams.push(`%${filters.customerName}%`, `%${filters.customerName}%`);
		}

		// Sector filters
		if (filters.sectorIds && filters.sectorIds.length > 0) {
			const placeholders = filters.sectorIds.map(() => "?").join(",");
			whereConditions.push(`EXISTS (
				SELECT 1 FROM wpp_contact_sectors wcs 
				WHERE wcs.contact_id = ctt.id 
				AND wcs.sector_id IN (${placeholders})
			)`);
			queryParams.push(...filters.sectorIds);
		}

		return {
			conditions: whereConditions,
			params: queryParams
		};
	}

	/**
	 * Build COUNT query for contacts
	 */
	public static buildCountQuery(whereClause: string): string {
		return `
			SELECT COUNT(*) as total
			FROM wpp_contacts ctt
			LEFT JOIN clientes cli ON ctt.customer_id = cli.CODIGO
			WHERE ${whereClause}
		`;
	}

	/**
	 * Build data query for contacts with all joined tables
	 */
	public static buildDataQuery(whereClause: string): string {
		return `
			SELECT 
				ctt.*,
				cli.CODIGO as customer_CODIGO,
				cli.RAZAO as customer_RAZAO,
				cli.FANTASIA as customer_FANTASIA,
				cli.CPF_CNPJ as customer_CPF_CNPJ,
				cli.COD_ERP as customer_COD_ERP,
				cli.FONE1 as customer_TELEFONE,
				cli.FONE2 as customer_CELULAR,
				cli.EMAIL as customer_EMAIL,
				op.NOME as operator_NOME,
				GROUP_CONCAT(wcs.sector_id) as sector_ids
			FROM wpp_contacts ctt
			LEFT JOIN clientes cli ON ctt.customer_id = cli.CODIGO
			LEFT JOIN wpp_chats chat ON ctt.id = chat.contact_id AND chat.is_finished = false
			LEFT JOIN operadores op ON chat.user_id = op.CODIGO
			LEFT JOIN wpp_contact_sectors wcs ON ctt.id = wcs.contact_id
			WHERE ${whereClause}
			GROUP BY ctt.id, op.NOME
			ORDER BY ctt.id DESC
			LIMIT ? OFFSET ?
		`;
	}
}
