import { BadRequestError } from "@rgranatodutra/http-errors";
import prismaService from "./prisma.service";

function parseDate(value: unknown): Date {
	if (typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) {
		const date = new Date(`${value}T00:00:00.000Z`);
		if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return date;
	}
	throw new BadRequestError("Informe uma data válida no formato AAAA-MM-DD.");
}

export async function listForInstances(instances: string[], through?: string) {
	const rows = await prismaService.chatAutoFinishClosedDate.findMany({
		where: { instance: { in: instances }, ...(through ? { date: { lte: parseDate(through) } } : {}) },
		select: { instance: true, date: true },
		orderBy: { date: "asc" }
	});
	return rows.map(({ instance, date }) => ({ instance, date: date.toISOString().slice(0, 10) }));
}

export async function addClosedDate(instance: string, value: unknown): Promise<void> {
	const date = parseDate(value);
	await prismaService.chatAutoFinishClosedDate.createMany({ data: [{ instance, date }], skipDuplicates: true });
}

export async function removeClosedDate(instance: string, value: unknown): Promise<void> {
	await prismaService.chatAutoFinishClosedDate.deleteMany({ where: { instance, date: parseDate(value) } });
}
