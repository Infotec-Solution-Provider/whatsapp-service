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
		if (filters.ids && filters.ids.length > 0) {
			const placeholders = filters.ids.map(() => "?").join(",");
			whereConditions.push(`ctt.id IN (${placeholders})`);
			queryParams.push(...filters.ids);
		} else if (typeof filters.id === "number" && Number.isFinite(filters.id)) {
			whereConditions.push("ctt.id = ?");
			queryParams.push(filters.id);
		}

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

		if (filters.phones && filters.phones.length > 0) {
			const normalizedPhones = filters.phones
				.map((phone) => phone.replace(/\D/g, ""))
				.filter((phone) => phone.length > 0);

			if (normalizedPhones.length > 0) {
				const placeholders = normalizedPhones.map(() => "?").join(",");
				whereConditions.push(`ctt.phone IN (${placeholders})`);
				queryParams.push(...normalizedPhones);
			}
		}

		if (filters.customerIds && filters.customerIds.length > 0) {
			const placeholders = filters.customerIds.map(() => "?").join(",");
			whereConditions.push(`ctt.customer_id IN (${placeholders})`);
			queryParams.push(...filters.customerIds);
		} else if (typeof filters.customerId === "number" && Number.isFinite(filters.customerId)) {
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

		if (filters.campaignIds?.length) {
			const placeholders = filters.campaignIds.map(() => "?").join(",");
			whereConditions.push(`cli.COD_CAMPANHA IN (${placeholders})`);
			queryParams.push(...filters.campaignIds);
		}

		if (filters.segmentIds?.length) {
			const placeholders = filters.segmentIds.map(() => "?").join(",");
			whereConditions.push(`cli.SEGMENTO IN (${placeholders})`);
			queryParams.push(...filters.segmentIds);
		}

		if (filters.registeredFrom) {
			whereConditions.push("cli.DATACAD >= ?");
			queryParams.push(`${filters.registeredFrom} 00:00:00`);
		}

		if (filters.registeredTo) {
			whereConditions.push("cli.DATACAD <= ?");
			queryParams.push(`${filters.registeredTo} 23:59:59`);
		}

		if (filters.purchaseStatus === "without_purchases") {
			whereConditions.push("NOT EXISTS (SELECT 1 FROM compras purchase WHERE purchase.CLIENTE = cli.CODIGO)");
		} else if (filters.purchaseStatus === "with_purchases" || filters.purchaseFrom || filters.purchaseTo) {
			const purchaseConditions = ["purchase.CLIENTE = cli.CODIGO"];
			if (filters.purchaseFrom) {
				purchaseConditions.push("purchase.DATA >= ?");
				queryParams.push(`${filters.purchaseFrom} 00:00:00`);
			}
			if (filters.purchaseTo) {
				purchaseConditions.push("purchase.DATA <= ?");
				queryParams.push(`${filters.purchaseTo} 23:59:59`);
			}
			whereConditions.push(`EXISTS (SELECT 1 FROM compras purchase WHERE ${purchaseConditions.join(" AND ")})`);
		}

		if (filters.loyaltyOperatorIds?.length) {
			const placeholders = filters.loyaltyOperatorIds.map(() => "?").join(",");
			whereConditions.push(`EXISTS (
				SELECT 1 FROM campanhas_clientes loyalty
				WHERE loyalty.CLIENTE = cli.CODIGO
				AND loyalty.OPERADOR IN (${placeholders})
				AND (loyalty.CONCLUIDO = 'NAO' OR loyalty.DT_RESULTADO < '1970-01-01')
			)`);
			queryParams.push(...filters.loyaltyOperatorIds);
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
