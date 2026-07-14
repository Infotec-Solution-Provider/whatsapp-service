export type RequestFilters<T> = {
	page?: string;
	perPage?: string;
	sortBy?: keyof T;
} & Partial<Record<keyof T, string>>;
