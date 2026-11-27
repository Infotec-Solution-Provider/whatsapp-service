import { createHash } from "node:crypto";
import { Logger } from "@in.pulse-crm/utils";
import { currentDatabaseTenant, normalizeDatabaseTenant, withDatabaseTenant } from "../utils/database-tenant-context";
import { isTemplateVariableSources, type TemplateVariableSource } from "../utils/meta-template-variable-sources";
import database from "./prisma.service";

function isMetaId(value: unknown): value is string {
	return typeof value === "string" && /^[1-9]\d{0,31}$/.test(value);
}

function isScoped(instance: string, accountId: string): boolean {
	const tenant = currentDatabaseTenant();
	return normalizeDatabaseTenant(instance) !== null && (!tenant || tenant === instance) && isMetaId(accountId);
}

function bodyHash(body: string): string {
	return createHash("sha256").update(body.trim().replace(/\r\n/g, "\n")).digest("hex");
}

function countPositions(body: string): number {
	return new Set(Array.from(body.matchAll(/\{\{([1-9]\d*)\}\}/g), match => match[1])).size;
}

export async function saveTemplateVariableSources(
	instance: string, accountId: string, templateId: string, body: string, variableSources: TemplateVariableSource[]
): Promise<boolean> {
	if (!isScoped(instance, accountId) || !isMetaId(templateId) || !isTemplateVariableSources(variableSources, countPositions(body))) {
		return false;
	}
	const hash = bodyHash(body);
	const sources = JSON.stringify(variableSources);
	try {
		await withDatabaseTenant(instance, async () => database.$executeRawUnsafe(
			`INSERT INTO meta_template_variable_bindings (instance, account_id, template_id, body_hash, variable_sources)
			 VALUES (?, ?, ?, ?, ?)
			 ON DUPLICATE KEY UPDATE body_hash = ?, variable_sources = ?`,
			instance, accountId, templateId, hash, sources, hash, sources
		));
		return true;
	} catch {
		Logger.warning("[Meta templates] Could not save variable sources.");
		return false;
	}
}

export async function loadTemplateVariableSources(
	instance: string, accountId: string, templates: ReadonlyArray<{ id: string; body: string }>
): Promise<Map<string, TemplateVariableSource[]>> {
	const bindings = new Map<string, TemplateVariableSource[]>();
	if (!isScoped(instance, accountId)) return bindings;
	const candidates = new Map(templates.filter(template => isMetaId(template.id) && countPositions(template.body) > 0)
		.map(template => [template.id, template.body]));
	if (!candidates.size) return bindings;

	try {
		const rows = await withDatabaseTenant(instance, async () => database.metaTemplateVariableBinding.findMany({
			where: { instance, accountId, templateId: { in: [...candidates.keys()] } },
			select: { templateId: true, bodyHash: true, variableSources: true }
		}));
		for (const row of rows) {
			const body = candidates.get(row.templateId);
			if (body && row.bodyHash === bodyHash(body) && isTemplateVariableSources(row.variableSources, countPositions(body))) {
				bindings.set(row.templateId, row.variableSources);
			}
		}
	} catch {
		Logger.warning("[Meta templates] Could not load variable sources.");
	}
	return bindings;
}
