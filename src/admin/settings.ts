import { Prisma, WppClient } from "@prisma/client";
import prisma from "../services/prisma.service";
import targets from "../services/parameter-settings-targets.service";
import whatsapp from "../services/whatsapp.service";
import { withDatabaseTenant } from "../utils/database-tenant-context";
import { tenantSqlEnabled } from "../tenant-sql/registry";
import { AdminCommand, AdminMutationResult, AdminProtocolError, AdminSnapshot, Json, requireRevision } from "./admin-protocol";
import { channelCatalog, parameterCatalog } from "./catalog";
import { validateChannel } from "./channel-contract";
import { beginApplyReceipt, completeReceipt, diff, Query, readReceipt, requireTransactional, secretKey, snapshot, tenant, validateChanges, writeReceipt } from "./settings-utils";
import { DEFAULT_HUMAN_BEHAVIOR_CONFIG as humanDefault, HumanBehaviorConfig } from "../utils/human-behavior.simulator";
import { isMonitorWaitThreshold, monitorWaitThresholdsError } from "../parameters/monitor-wait-thresholds";

type Db = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
const execute = (db: Db): Query => async <T>(sql: string, params: unknown[] = []) => (/^\s*(SELECT|SHOW)\b/i.test(sql) ? await db.$queryRawUnsafe(sql, ...params) : await db.$executeRawUnsafe(sql, ...params)) as T;
interface Row { id: number; scope: string; key: string; value: string; instance: string | null; sectorId: number | null; userId: number | null }
function resourceId(command: AdminCommand): number {
  const id = Number(command.target?.resourceId);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2147483647) throw new AdminProtocolError(400, "Selecione um canal.");
  return id;
}
async function parameterState(command: AdminCommand, query: Query, lock = false) {
  const target = await targets.resolve(tenant(command), command.target);
  const sector = target.scope === "SECTOR" ? target.sectorId : "inheritedSectorId" in target ? target.inheritedSectorId : null;
  const rows = await query<Row[]>(`SELECT id,scope,\`key\`,value,instance,sectorId,userId FROM parameters WHERE instance=? OR (instance IS NULL AND sectorId=?) ORDER BY id ASC${lock ? " FOR UPDATE" : ""}`, [command.tenant!, sector ?? null]);
  const map = (selected: Row[]) => Object.fromEntries(selected.map(row => [row.key, row.value]));
  const instances = map(rows.filter(row => row.scope === "INSTANCE" && row.instance === command.tenant));
  const sectors = map(rows.filter(row => row.scope === "SECTOR" && row.sectorId === sector && row.userId === null));
  const ownRows = rows.filter(row => target.scope === "INSTANCE" ? row.scope === "INSTANCE" && row.instance === command.tenant : target.scope === "SECTOR" ? row.scope === "SECTOR" && row.sectorId === target.sectorId && row.userId === null : row.scope === "USER" && row.instance === command.tenant && row.userId === target.userId);
  const own = map(ownRows);
  const catalog = parameterCatalog.filter(field => field.supportedScopes!.includes(target.scope)).map(field => ({ ...field }));
  for (const key of new Set([...Object.keys(instances), ...Object.keys(sectors), ...Object.keys(own)])) if (!parameterCatalog.some(field => field.key === key)) catalog.push({ key, label: key, description: "Parâmetro existente aguardando classificação do consumidor e do tipo.", category: "Aguardando classificação", type: secretKey(key) ? "secret" : "json", supportedScopes: [target.scope], readOnly: true, canReset: false, unavailableReason: "Consumidor e contrato ainda não classificados." });
  const state: Record<string, unknown> = Object.fromEntries(catalog.map(field => [field.key, own[field.key] ?? null]));
  state["_parents"] = target.scope === "INSTANCE" ? {} : { instances, sectors };
  const saved = snapshot(command, state, catalog, { state: "unknown", message: "Parâmetros dinâmicos são lidos nas próximas consultas. Comportamento humano requer reaplicação." });
  const inherited: NonNullable<AdminSnapshot["inherited"]> = {};
  for (const field of catalog) {
    const sectorValue = target.scope === "USER" ? sectors[field.key] : undefined;
    const instanceValue = target.scope !== "INSTANCE" ? instances[field.key] : undefined;
    const value = sectorValue ?? instanceValue ?? field.defaultValue ?? null;
    inherited[field.key] = { value: field.type === "secret" ? null : field.type === "boolean" && value !== null ? value === true || value === "true" : value as Json, source: sectorValue !== undefined ? "SECTOR" : instanceValue !== undefined ? "INSTANCE" : "DEFAULT" };
  }
  saved.inherited = inherited;
  return { target, state, catalog, snapshot: saved, ownRows };
}
const channelColumns: Record<string, string> = { name: "name", phone: "phone", type: "type", isActive: "is_active", WABAPhoneId: "waba_phone_id", WABAAccountId: "waba_account_id", WABAToken: "waba_token", gupshupToken: "gupshup_token", gupshupAppName: "gupshup_app_name", gupshupAppId: "gupshup_app_id", remoteClientUrl: "remote_client_url" };
function humanConfiguration(state: Record<string, unknown>): HumanBehaviorConfig {
  const bool = (key: string, fallback: boolean) => state[key] == null ? fallback : [true, "true", "1", "yes"].includes(state[key] as string | boolean);
  const range = (name: string, fallback: { min: number; max: number }) => ({ min: Number(state[`human_behavior.${name}.min`] ?? fallback.min), max: Number(state[`human_behavior.${name}.max`] ?? fallback.max) });
  return { enabled: bool("human_behavior.enabled", humanDefault.enabled), sendTypingState: bool("human_behavior.send_typing_state", humanDefault.sendTypingState), readingSpeed: range("reading_speed", humanDefault.readingSpeed), thinkingTime: range("thinking_time", humanDefault.thinkingTime), typingSpeed: range("typing_speed", humanDefault.typingSpeed), typingStateDuration: range("typing_state_duration", humanDefault.typingStateDuration) };
}
async function channels(command: AdminCommand, query: Query, lock = false) {
  const resources = await query<{ id: number; label: string }[]>("SELECT id,name AS label FROM clients WHERE instance=? ORDER BY name,id", [tenant(command)]);
  const catalog = channelCatalog.map(field => ({ ...field }));
  if (command.target?.resourceId === undefined) return { state: {}, catalog, snapshot: { ...snapshot(command, {}, [], { state: "unknown" }), resources, unavailableReason: "Selecione um canal para consultar e editar." } };
  const columns = Object.entries(channelColumns).map(([key, column]) => `\`${column}\` AS \`${key}\``).join(",");
  const rows = await query<Record<string, unknown>[]>(`SELECT id,${columns} FROM clients WHERE id=? AND instance=?${lock ? " FOR UPDATE" : ""}`, [resourceId(command), command.tenant!]);
  if (!rows[0]) throw new AdminProtocolError(404, "Canal não encontrado no tenant alvo.");
  const result = snapshot(command, rows[0], catalog, { state: "unknown", message: "Reaplique o canal após salvar suas credenciais." });
  result.resources = resources;
  return { state: rows[0], catalog, snapshot: result };
}
export async function whatsappSettings(command: AdminCommand): Promise<unknown> {
  return withDatabaseTenant(tenant(command), async () => {
    if (command.action === "getTargets") {
      const selected = command.target?.scope ?? "USER";
      if (selected === "INSTANCE") return { targets: [] };
      const result = await targets.list(command.tenant!, command.search ?? "", selected);
      return { targets: selected === "SECTOR" ? result.sectors.map(item => ({ id: item.id, label: item.name })) : result.users.map(item => ({ id: item.id, label: item.name, active: item.active })), hasMore: result.hasMoreUsers };
    }
    if (!["whatsapp", "channels"].includes(command.source ?? "")) throw new AdminProtocolError(400, "Fonte WhatsApp inválida.");
    const query = execute(prisma);
    if (command.action === "getReceipt") return await readReceipt(query, command) ?? { found: false };
    const load = (db: Query, lock = false) => command.source === "channels" ? channels(command, db, lock) : parameterState(command, db, lock);
    if (command.action === "getSettings") return (await load(query)).snapshot;
    if (command.action !== "saveSettings" && command.action !== "applySettings") throw new AdminProtocolError(400, "Ação WhatsApp inválida.");
    if (command.action === "applySettings") {
      if (command.source === "channels") resourceId(command);
      else if ((command.target?.scope ?? "INSTANCE") !== "INSTANCE") throw new AdminProtocolError(400, "Comportamento humano é uma configuração da instância.");
      const prepared = await prisma.$transaction(async tx => {
        const executeTx = execute(tx);
        await requireTransactional(executeTx, ["admin_operation_receipts", `${tenantSqlEnabled() ? "wpp_runtime_" : ""}${command.source === "channels" ? "clients" : "parameters"}`]);
        const receipt = await readReceipt(executeTx, command, true);
        if (receipt) return { kind: "existing" as const, result: receipt };
        const before = await load(executeTx, true);
        requireRevision(command.revision, before.snapshot.revision);
        // Durable intent must commit before touching provider clients or in-memory configuration.
        await beginApplyReceipt(executeTx, command);
        return { kind: "execute" as const, before };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
      if (prepared.kind === "existing") return prepared.result;
      try {
        const before = prepared.before;
        if (command.source === "channels") {
          const captured = { ...before.state, instance: command.tenant!, id: resourceId(command), isActive: before.state["isActive"] === true || before.state["isActive"] === 1 || before.state["isActive"] === "true" } as WppClient;
          await whatsapp.reloadClient(command.tenant!, resourceId(command), captured);
        } else await whatsapp.reloadHumanBehavior(command.tenant!, humanConfiguration(before.state));
        const after = await load(query);
        const saved = { ...after.snapshot, application: { state: after.snapshot.revision === before.snapshot.revision ? "applied" as const : "pending" as const, revision: before.snapshot.revision, message: "A revisão autorizada foi carregada no recurso. Alterações posteriores permanecem pendentes." } };
        const result: AdminMutationResult = { operationId: command.operationId!, state: "COMMITTED", revision: saved.revision, snapshot: saved, application: saved.application };
        await prisma.$transaction(tx => completeReceipt(execute(tx), command, result));
        return result;
      } catch { throw new AdminProtocolError(503, "Reaplicação iniciada sem confirmação persistida. Esta operação não será repetida automaticamente."); }
    }
    try { return await prisma.$transaction(async tx => {
      const executeTx = execute(tx);
      await requireTransactional(executeTx, ["admin_operation_receipts", `${tenantSqlEnabled() ? "wpp_runtime_" : ""}${command.source === "channels" ? "clients" : "parameters"}`]);
      const receipt = await readReceipt(executeTx, command, true);
      if (receipt) return receipt;
      const before = await load(executeTx, true);
      requireRevision(command.revision, before.snapshot.revision);
      const changes = validateChanges(command, before.catalog);
      if (command.source === "channels") {
        resourceId(command);
        const next = { ...before.state };
        for (const change of changes) {
          if (change.action === "reset") throw new AdminProtocolError(400, "Canal não possui valor padrão para este campo.");
          if (change.action === "remove" && ["name", "type", "isActive"].includes(change.key)) throw new AdminProtocolError(400, "Campo obrigatório do canal.");
          next[change.key] = change.action === "remove" ? null : change.value;
        }
        validateChannel(next);
        await executeTx(`UPDATE clients SET ${changes.map(change => `\`${channelColumns[change.key]}\`=?`).join(",")} WHERE id=? AND instance=?`, [...changes.map(change => change.key === "isActive" ? next[change.key] === true || next[change.key] === "true" || next[change.key] === 1 ? 1 : 0 : next[change.key]), resourceId(command), command.tenant!]);
      } else {
        const params = before as Awaited<ReturnType<typeof parameterState>>;
        const next = { ...params.state };
        for (const change of changes) next[change.key] = change.action === "set" ? String(change.value) : null;
        if (changes.some(change => isMonitorWaitThreshold(change.key))) {
          const effective = Object.fromEntries(params.catalog.map(field => [field.key,
            next[field.key] ?? params.snapshot.inherited?.[field.key]?.value ?? field.defaultValue]));
          const error = monitorWaitThresholdsError(effective);
          if (error) throw new AdminProtocolError(400, error);
        }
        for (const group of ["reading_speed", "thinking_time", "typing_speed", "typing_state_duration"]) {
          const lowKey = `human_behavior.${group}.min`, highKey = `human_behavior.${group}.max`;
          const low = next[lowKey] ?? params.catalog.find(field => field.key === lowKey)?.defaultValue;
          const high = next[highKey] ?? params.catalog.find(field => field.key === highKey)?.defaultValue;
          if (low != null && high != null && Number(low) > Number(high)) throw new AdminProtocolError(400, "O mínimo do comportamento humano não pode exceder o máximo.");
        }
        for (const change of changes) {
          const field = params.catalog.find(item => item.key === change.key)!;
          if (change.action === "set" && field.type === "number" && field.step === 1 && !Number.isSafeInteger(Number(change.value))) throw new AdminProtocolError(400, "Este parâmetro exige número inteiro.");
          const ids = params.ownRows.filter(row => row.key === change.key).map(row => row.id);
          if (change.action !== "set") {
            if (ids.length) await executeTx(`DELETE FROM parameters WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
          } else if (ids.length) await executeTx(`UPDATE parameters SET value=? WHERE id IN (${ids.map(() => "?").join(",")})`, [String(change.value), ...ids]);
          else await executeTx("INSERT INTO parameters (scope,instance,sectorId,userId,`key`,value) VALUES (?,?,?,?,?,?)", [params.target.scope, command.tenant!, params.target.scope === "SECTOR" ? params.target.sectorId : null, params.target.scope === "USER" ? params.target.userId : null, change.key, String(change.value)]);
        }
      }
      const after = await load(executeTx);
      const pending = command.source === "channels" || changes.some(change => change.key.startsWith("human_behavior."));
      const saved = { ...after.snapshot, application: { state: pending ? "pending" as const : "applied" as const } };
      const result: AdminMutationResult = { operationId: command.operationId!, state: "COMMITTED", revision: saved.revision, snapshot: saved, changes: diff(changes, before.state, after.state, before.catalog), application: saved.application };
      await writeReceipt(executeTx, command, result);
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 }); }
    catch (error) {
      if ((error as { code?: string })?.code === "P2034") throw new AdminProtocolError(409, "Houve uma alteração simultânea. Recarregue a configuração.");
      throw error;
    }
  }).catch((error: unknown) => {
    const status = (error as { status?: number })?.status;
    if ([400, 403, 404, 409].includes(status ?? 0)) throw new AdminProtocolError(status!, error instanceof Error ? error.message : "Alvo administrativo inválido.");
    throw error;
  });
}
