export interface DataResponse<T> {
	message: string;
	data: T;
}

export interface MessageResponse {
	message: string;
}

export interface ErrorResponse {
	message: string;
	cause?: any;
}

export interface PaginatedResponse<T> {
	message: string;
	data: Array<T>;
	page: {
		current: number;
		totalRows: number;
	};
}

export interface FlexiblePaginatedResponse<T> {
	message: string;
	data: Array<T>;
	page: {
		current: number;
		totalRows: number;
	};
}

export interface QueryResponse<T> {
	result: T;
}
