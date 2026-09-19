import { Prisma } from "@prisma/client";
import { databaseOperationMetrics, type DatabaseOperationMetrics } from "./database-operation-metrics";

export function databaseOperationExtension(metrics: DatabaseOperationMetrics = databaseOperationMetrics) {
	return Prisma.defineExtension({
		name: "database-operation-metrics",
		query: {
			$allOperations({ model, operation, args, query }) {
				// Forward the provided query to preserve the current transaction.
				return metrics.measure(model, operation, () => query(args));
			},
		},
	});
}
