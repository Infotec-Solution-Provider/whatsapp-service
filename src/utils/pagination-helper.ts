interface PaginationParams {
	page: number;
	perPage: number;
}

interface PaginationResponse {
	page: number;
	perPage: number;
	total: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

/**
 * Helper for pagination logic
 */
export class PaginationHelper {
	/**
	 * Validate and normalize pagination parameters
	 */
	public static validatePagination(page: number, perPage: number): PaginationParams {
		return {
			page: Math.max(1, page),
			perPage: Math.max(1, Math.min(100, perPage))
		};
	}

	/**
	 * Calculate offset for SQL LIMIT clause
	 */
	public static calculateOffset(page: number, perPage: number): number {
		return (page - 1) * perPage;
	}

	/**
	 * Build pagination response object
	 */
	public static buildPaginationResponse(page: number, perPage: number, total: number): PaginationResponse {
		const totalPages = Math.ceil(total / perPage);

		return {
			page,
			perPage,
			total,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1
		};
	}

	/**
	 * Build empty pagination response
	 */
	public static buildEmptyResponse(page: number, perPage: number): PaginationResponse {
		return {
			page,
			perPage,
			total: 0,
			totalPages: 0,
			hasNext: false,
			hasPrev: false
		};
	}
}
