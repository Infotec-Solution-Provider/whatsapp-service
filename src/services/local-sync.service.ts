import instancesService from "./instances.service";
import prismaService from "./prisma.service";

interface SyncOptions {
	skipContacts?: boolean;
	skipSectors?: boolean;
	skipChats?: boolean;
	skipMessages?: boolean;
	skipSchedules?: boolean;
}

class LocalSyncService {
	/**
	 * Safely encode string for storage (handles emojis and special chars)
	 */
	private safeEncode(value: string | null | undefined): string | null {
		if (!value) return null;
		try {
			return encodeURIComponent(value);
		} catch (err) {
			console.error(`[LocalSync] Erro ao fazer encode:`, err);
			return value;
		}
	}

	/**
	 * Ensure all required local tables exist in the tenant database
	 */
	private async ensureTablesExist(instance: string): Promise<void> {
		console.log(`[LocalSync] Verificando tabelas no banco do tenant: ${instance}`);

		const createContactsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_contacts (
				id INT NOT NULL,
				instance VARCHAR(255) NOT NULL,
				name VARCHAR(255) NOT NULL,
				phone VARCHAR(50) NOT NULL,
				customer_id INT NULL,
				is_deleted TINYINT(1) NOT NULL DEFAULT 0,
				PRIMARY KEY (id),
				UNIQUE KEY unique_instance_phone (instance, phone),
				INDEX idx_customer_id (customer_id),
				INDEX idx_phone (phone)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		const createContactSectorsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_contact_sectors (
				contact_id INT NOT NULL,
				sector_id INT NOT NULL,
				PRIMARY KEY (contact_id, sector_id),
				INDEX idx_sector_id (sector_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		const createChatsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_chats (
				id INT AUTO_INCREMENT PRIMARY KEY,
				original_id INT NOT NULL UNIQUE,
				instance VARCHAR(255) NOT NULL,
				type VARCHAR(50) NOT NULL,
				avatar_url TEXT NULL,
				user_id INT NULL,
				contact_id INT NULL,
				sector_id INT NULL,
				started_at DATETIME NULL,
				finished_at DATETIME NULL,
				finished_by INT NULL,
				result_id INT NULL,
				is_finished TINYINT(1) NOT NULL DEFAULT 0,
				is_schedule TINYINT(1) NOT NULL DEFAULT 0,
				INDEX idx_original_id (original_id),
				INDEX idx_contact_id (contact_id),
				INDEX idx_user_id (user_id),
				INDEX idx_is_finished (is_finished),
				INDEX idx_sector_id (sector_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		const createMessagesTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_messages (
				id INT NOT NULL,
				instance VARCHAR(255) NOT NULL,
				wwebjs_id VARCHAR(255) NULL,
				wwebjs_id_stanza VARCHAR(255) NULL,
				waba_id VARCHAR(255) NULL,
				gupshup_id VARCHAR(255) NULL,
				gupshup_request_id VARCHAR(255) NULL,
				\`from\` VARCHAR(255) NOT NULL,
				\`to\` VARCHAR(255) NOT NULL,
				type VARCHAR(50) NOT NULL,
				quoted_id INT NULL,
				chat_id INT NULL,
				contact_id INT NULL,
				is_forwarded TINYINT(1) NOT NULL DEFAULT 0,
				is_edited TINYINT(1) NOT NULL DEFAULT 0,
				body LONGTEXT NOT NULL,
				timestamp VARCHAR(64) NOT NULL,
				sent_at DATETIME NOT NULL,
				status VARCHAR(50) NOT NULL,
				file_id INT NULL,
				file_name TEXT NULL,
				file_type VARCHAR(255) NULL,
				file_size VARCHAR(255) NULL,
				user_id INT NULL,
				billing_category VARCHAR(255) NULL,
				client_id INT NULL,
				PRIMARY KEY (id),
				UNIQUE KEY unique_wwebjs_id (wwebjs_id),
				UNIQUE KEY unique_wwebjs_id_stanza (wwebjs_id_stanza),
				UNIQUE KEY unique_waba_id (waba_id),
				UNIQUE KEY unique_gupshup_id (gupshup_id),
				INDEX idx_contact_id (contact_id),
				INDEX idx_chat_id (chat_id),
				INDEX idx_sent_at (sent_at),
				INDEX idx_status (status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		const createSchedulesTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_schedules (
				id INT NOT NULL,
				instance VARCHAR(255) NOT NULL,
				description TEXT NULL,
				contact_id INT NOT NULL,
				chat_id INT NULL,
				scheduled_at DATETIME NOT NULL,
				schedule_date DATETIME NOT NULL,
				scheduled_by INT NOT NULL,
				scheduled_for INT NOT NULL,
				sector_id INT NULL,
				PRIMARY KEY (id),
				INDEX idx_contact_id (contact_id),
				INDEX idx_chat_id (chat_id),
				INDEX idx_scheduled_at (scheduled_at),
				INDEX idx_schedule_date (schedule_date)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		try {
			await instancesService.executeQuery(instance, createContactsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contacts verificada/criada`);

			await instancesService.executeQuery(instance, createContactSectorsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contact_sectors verificada/criada`);

			await instancesService.executeQuery(instance, createChatsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_chats verificada/criada`);

			await instancesService.executeQuery(instance, createMessagesTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_messages verificada/criada`);

			await instancesService.executeQuery(instance, createSchedulesTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_schedules verificada/criada`);

			// Alter table charset to utf8 if needed
			try {
				const alterContactsQuery = `ALTER TABLE wpp_contacts CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterContactsQuery, []);
				console.log(`[LocalSync] Charset de wpp_contacts alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_contacts charset já é utf8 ou erro ao alterar`);
				}
			}

			try {
				const alterSectorsQuery = `ALTER TABLE wpp_contact_sectors CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterSectorsQuery, []);
				console.log(`[LocalSync] Charset de wpp_contact_sectors alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_contact_sectors charset já é utf8 ou erro ao alterar`);
				}
			}

			try {
				const alterChatsQuery = `ALTER TABLE wpp_chats CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterChatsQuery, []);
				console.log(`[LocalSync] Charset de wpp_chats alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_chats charset já é utf8 ou erro ao alterar`);
				}
			}

			try {
				const alterMessagesQuery = `ALTER TABLE wpp_messages CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterMessagesQuery, []);
				console.log(`[LocalSync] Charset de wpp_messages alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_messages charset já é utf8 ou erro ao alterar`);
				}
			}

			try {
				const alterSchedulesQuery = `ALTER TABLE wpp_schedules CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterSchedulesQuery, []);
				console.log(`[LocalSync] Charset de wpp_schedules alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_schedules charset já é utf8 ou erro ao alterar`);
				}
			}

			// Ensure original_id column exists - with proper migration
			try {
				const checkColumnQuery = `
					SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
					WHERE TABLE_NAME = 'wpp_chats' AND COLUMN_NAME = 'original_id'
				`;

				const columnExists = await instancesService.executeQuery<any[]>(instance, checkColumnQuery, []);

				if (!columnExists || columnExists.length === 0) {
					console.log(`[LocalSync] Coluna original_id não encontrada, adicionando...`);

					// Add column as nullable first
					const addColumnQuery = `ALTER TABLE wpp_chats ADD COLUMN original_id INT NULL AFTER id`;
					await instancesService.executeQuery(instance, addColumnQuery, []);
					console.log(`[LocalSync] Coluna original_id adicionada como NULL`);

					// Fill with the id value from existing rows
					const fillColumnQuery = `UPDATE wpp_chats SET original_id = id WHERE original_id IS NULL`;
					await instancesService.executeQuery(instance, fillColumnQuery, []);
					console.log(`[LocalSync] Coluna original_id preenchida com valores de id`);

					// Modify column to NOT NULL and add UNIQUE constraint
					const modifyColumnQuery = `ALTER TABLE wpp_chats MODIFY COLUMN original_id INT NOT NULL UNIQUE`;
					await instancesService.executeQuery(instance, modifyColumnQuery, []);
					console.log(`[LocalSync] Coluna original_id modificada para NOT NULL UNIQUE`);

					// Add index if not exists
					const addIndexQuery = `ALTER TABLE wpp_chats ADD INDEX idx_original_id (original_id)`;
					await instancesService.executeQuery(instance, addIndexQuery, []);
					console.log(`[LocalSync] Index original_id adicionado`);
				} else {
					console.log(`[LocalSync] Coluna original_id já existe`);
				}
			} catch (err: any) {
				console.error(`[LocalSync] Erro ao migrar coluna original_id: ${err.message}`);
				throw err;
			}
		} catch (error) {
			console.error(`[LocalSync] Erro ao criar tabelas:`, error);
			throw error;
		}
	}

	/**
	 * Sync all contacts from Prisma to local database
	 */
	private async syncContacts(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando contatos para: ${instance}`);

		const contacts = await prismaService.wppContact.findMany({
			where: { instance }
		});

		if (contacts.length === 0) {
			console.log(`[LocalSync] Nenhum contato encontrado para sincronizar`);
			return 0;
		}

		const batchSize = 100;
		let syncedCount = 0;

		for (let i = 0; i < contacts.length; i += batchSize) {
			const batch = contacts.slice(i, i + batchSize);

			// Create placeholders (?,?,?,?,?,?) for each contact
			const placeholders = batch.map(() => "(?,?,?,?,?,?)").join(", ");
			
			// Flatten all values into a single array
			const values: any[] = [];
			batch.forEach((c) => {
				values.push(
					c.id,
					c.instance,
					c.name,
					c.phone,
					c.customerId,
					c.isDeleted ? 1 : 0
				);
			});

			const query = `
				INSERT INTO wpp_contacts (id, instance, name, phone, customer_id, is_deleted)
				VALUES ${placeholders}
				ON DUPLICATE KEY UPDATE
					name = VALUES(name),
					phone = VALUES(phone),
					customer_id = VALUES(customer_id),
					is_deleted = VALUES(is_deleted)
			`;

			await instancesService.executeQuery(instance, query, values);
			syncedCount += batch.length;
		}

		console.log(`[LocalSync] ${syncedCount} contatos sincronizados`);
		return syncedCount;
	}

	/**
	 * Sync all contact sectors from Prisma to local database
	 */
	private async syncContactSectors(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando setores de contatos para: ${instance}`);

		// Get all contacts with sectors for this instance
		const contacts = await prismaService.wppContact.findMany({
			where: { instance },
			include: { sectors: true } as any
		});

		// First, clear all existing sectors for this instance's contacts
		const contactIds = contacts.map((c) => c.id);
		if (contactIds.length > 0) {
			const deleteQuery = `DELETE FROM wpp_contact_sectors WHERE contact_id IN (${contactIds.join(",")})`;
			await instancesService.executeQuery(instance, deleteQuery, []);
		}

		// Now insert all sectors
		let syncedCount = 0;
		const allSectorRelations: Array<{ contactId: number; sectorId: number }> = [];

		contacts.forEach((contact: any) => {
			const sectors = contact.sectors || [];
			sectors.forEach((sector: any) => {
				allSectorRelations.push({
					contactId: contact.id,
					sectorId: sector.sectorId
				});
			});
		});

		if (allSectorRelations.length === 0) {
			console.log(`[LocalSync] Nenhum setor de contato encontrado para sincronizar`);
			return 0;
		}

		const batchSize = 500;
		for (let i = 0; i < allSectorRelations.length; i += batchSize) {
			const batch = allSectorRelations.slice(i, i + batchSize);
			
			// Create placeholders for 2 fields per relation
			const placeholders = batch.map(() => "(?,?)").join(", ");
			
			// Flatten all values
			const values: any[] = [];
			batch.forEach((rel) => {
				values.push(rel.contactId, rel.sectorId);
			});

			const query = `
				INSERT INTO wpp_contact_sectors (contact_id, sector_id)
				VALUES ${placeholders}
			`;

			await instancesService.executeQuery(instance, query, values);
			syncedCount += batch.length;
		}

		console.log(`[LocalSync] ${syncedCount} setores de contatos sincronizados`);
		return syncedCount;
	}

	/**
	 * Sync all chats from Prisma to local database
	 */
	private async syncChats(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando chats para: ${instance}`);

		const chats = await prismaService.wppChat.findMany({
			where: { instance }
		});

		if (chats.length === 0) {
			console.log(`[LocalSync] Nenhum chat encontrado para sincronizar`);
			return 0;
		}

		const batchSize = 100;
		let syncedCount = 0;

		for (let i = 0; i < chats.length; i += batchSize) {
			const batch = chats.slice(i, i + batchSize);

			// Create placeholders for 14 fields per chat
			const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(", ");
			
			// Flatten all values
			const values: any[] = [];
			batch.forEach((chat) => {
				values.push(
					chat.id,
					chat.id, // original_id
					chat.instance,
					chat.type,
					this.safeEncode(chat.avatarUrl),
					chat.userId,
					chat.contactId,
					chat.sectorId,
					this.formatDateForMySQL(chat.startedAt),
					this.formatDateForMySQL(chat.finishedAt),
					chat.finishedBy,
					chat.resultId,
					chat.isFinished ? 1 : 0,
					chat.isSchedule ? 1 : 0
				);
			});

			const query = `
				INSERT INTO wpp_chats (
					id, original_id, instance, type, avatar_url, user_id, contact_id,
					sector_id, started_at, finished_at, finished_by,
					result_id, is_finished, is_schedule
				)
				VALUES ${placeholders}
				ON DUPLICATE KEY UPDATE
					type = VALUES(type),
					avatar_url = VALUES(avatar_url),
					user_id = VALUES(user_id),
					contact_id = VALUES(contact_id),
					sector_id = VALUES(sector_id),
					started_at = VALUES(started_at),
					finished_at = VALUES(finished_at),
					finished_by = VALUES(finished_by),
					result_id = VALUES(result_id),
					is_finished = VALUES(is_finished),
					is_schedule = VALUES(is_schedule)
			`;

			try {
				await instancesService.executeQuery(instance, query, values);
				syncedCount += batch.length;
			} catch (err) {
				console.error(`[LocalSync] Erro ao sincronizar batch de chats:`, err);
				throw err;
			}
		}

		console.log(`[LocalSync] ${syncedCount} chats sincronizados`);
		return syncedCount;
	}

	/**
	 * Sync all messages from Prisma to local database
	 */
	private async syncMessages(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando mensagens para: ${instance}`);

		const messages = await prismaService.wppMessage.findMany({
			where: { instance }
		});

		if (messages.length === 0) {
			console.log(`[LocalSync] Nenhuma mensagem encontrada para sincronizar`);
			return 0;
		}

		let syncedCount = 0;
		let errorCount = 0;

		// Inserir um por um para identificar mensagens problemáticas
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i];
			if (!msg) continue;

			const query = `
				INSERT INTO wpp_messages (
					id, instance, wwebjs_id, wwebjs_id_stanza, waba_id, gupshup_id, gupshup_request_id,
					\`from\`, \`to\`, type, quoted_id, chat_id, contact_id, is_forwarded, is_edited,
					body, timestamp, sent_at, status, file_id, file_name, file_type, file_size,
					user_id, billing_category, client_id
				)
				VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
				ON DUPLICATE KEY UPDATE
					wwebjs_id = VALUES(wwebjs_id),
					wwebjs_id_stanza = VALUES(wwebjs_id_stanza),
					waba_id = VALUES(waba_id),
					gupshup_id = VALUES(gupshup_id),
					gupshup_request_id = VALUES(gupshup_request_id),
					\`from\` = VALUES(\`from\`),
					\`to\` = VALUES(\`to\`),
					type = VALUES(type),
					quoted_id = VALUES(quoted_id),
					chat_id = VALUES(chat_id),
					contact_id = VALUES(contact_id),
					is_forwarded = VALUES(is_forwarded),
					is_edited = VALUES(is_edited),
					body = VALUES(body),
					timestamp = VALUES(timestamp),
					sent_at = VALUES(sent_at),
					status = VALUES(status),
					file_id = VALUES(file_id),
					file_name = VALUES(file_name),
					file_type = VALUES(file_type),
					file_size = VALUES(file_size),
					user_id = VALUES(user_id),
					billing_category = VALUES(billing_category),
					client_id = VALUES(client_id)
			`;

			const values = [
				msg.id,
				msg.instance,
				msg.wwebjsId,
				msg.wwebjsIdStanza,
				msg.wabaId,
				msg.gupshupId,
				msg.gupshupRequestId,
				msg.from,
				msg.to,
				msg.type,
				msg.quotedId,
				msg.chatId,
				msg.contactId,
				msg.isForwarded ? 1 : 0,
				msg.isEdited ? 1 : 0,
				this.safeEncode(msg.body),
				msg.timestamp,
				this.formatDateForMySQL(msg.sentAt),
				msg.status,
				msg.fileId,
				this.safeEncode(msg.fileName),
				msg.fileType,
				msg.fileSize,
				msg.userId,
				msg.billingCategory,
				msg.clientId
			];

			try {
				await instancesService.executeQuery(instance, query, values);
				syncedCount++;
				
				// Log progresso a cada 50 mensagens
				if ((i + 1) % 50 === 0) {
					console.log(`[LocalSync] Progresso: ${i + 1}/${messages.length} mensagens sincronizadas`);
				}
			} catch (err: any) {
				errorCount++;
				console.error(`\n[LocalSync] ========== ERRO NA MENSAGEM ${i + 1}/${messages.length} ==========`);
				console.error(`[LocalSync] ID: ${msg.id}`);
				console.error(`[LocalSync] From: ${msg.from}`);
				console.error(`[LocalSync] To: ${msg.to}`);
				console.error(`[LocalSync] Type: ${msg.type}`);
				console.error(`[LocalSync] Body (primeiros 200 chars): ${msg.body?.substring(0, 200)}`);
				console.error(`[LocalSync] FileName: ${msg.fileName}`);
				console.error(`[LocalSync] SentAt: ${msg.sentAt}`);
				console.error(`[LocalSync] Erro SQL: ${err.message}`);
				console.error(`[LocalSync] ============================================\n`);
				
				// Abortar após 10 erros para não poluir muito o log
				if (errorCount >= 10) {
					console.error(`[LocalSync] ABORTANDO: Muitos erros consecutivos (${errorCount})`);
					throw err;
				}
			}
		}

		console.log(`[LocalSync] ${syncedCount} mensagens sincronizadas (${errorCount} erros)`);
		return syncedCount;
	}

	/**
	 * Sync all schedules from Prisma to local database
	 */
	private async syncSchedules(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando agendamentos para: ${instance}`);

		const schedules = await prismaService.wppSchedule.findMany({
			where: { instance }
		});

		if (schedules.length === 0) {
			console.log(`[LocalSync] Nenhum agendamento encontrado para sincronizar`);
			return 0;
		}

		const batchSize = 50;
		let syncedCount = 0;

		for (let i = 0; i < schedules.length; i += batchSize) {
			const batch = schedules.slice(i, i + batchSize);

			// Create placeholders for 10 fields per schedule
			const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(", ");
			
			// Flatten all values
			const values: any[] = [];
			batch.forEach((schedule) => {
				values.push(
					schedule.id,
					schedule.instance,
				this.safeEncode(schedule.description),
					schedule.contactId,
					schedule.chatId,
					this.formatDateForMySQL(schedule.scheduledAt),
					this.formatDateForMySQL(schedule.scheduleDate),
					schedule.scheduledBy,
					schedule.scheduledFor,
					schedule.sectorId
				);
			});

			const query = `
				INSERT INTO wpp_schedules (
					id, instance, description, contact_id, chat_id, scheduled_at, schedule_date,
					scheduled_by, scheduled_for, sector_id
				)
				VALUES ${placeholders}
				ON DUPLICATE KEY UPDATE
					description = VALUES(description),
					contact_id = VALUES(contact_id),
					chat_id = VALUES(chat_id),
					scheduled_at = VALUES(scheduled_at),
					schedule_date = VALUES(schedule_date),
					scheduled_by = VALUES(scheduled_by),
					scheduled_for = VALUES(scheduled_for),
					sector_id = VALUES(sector_id)
			`;

			try {
				await instancesService.executeQuery(instance, query, values);
				syncedCount += batch.length;
			} catch (err) {
				console.error(`[LocalSync] Erro ao sincronizar batch de agendamentos:`, err);
				console.error(`[LocalSync] Query: ${query.substring(0, 500)}...`);
				throw err;
			}
		}

		console.log(`[LocalSync] ${syncedCount} agendamentos sincronizados`);
		return syncedCount;
	}

	/**
	 * Format date to MySQL datetime format (YYYY-MM-DD HH:MM:SS)
	 * Returns NULL literal (without quotes) for use in raw SQL strings
	 */
	private formatDateForMySQL(date: Date | null | undefined): string | null {
		if (!date) return null;

		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const seconds = String(date.getSeconds()).padStart(2, "0");

		return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
	}

	/**
	 * Run full synchronization for a specific instance
	 */
	public async syncInstance(instance: string, options: SyncOptions = {}): Promise<void> {
		console.log(`[LocalSync] ====== Iniciando sincronizacao para: ${instance} ======`);
		
		if (options.skipContacts) console.log(`[LocalSync] Pulando sincronizacao de contatos`);
		if (options.skipSectors) console.log(`[LocalSync] Pulando sincronizacao de setores`);
		if (options.skipChats) console.log(`[LocalSync] Pulando sincronizacao de chats`);
		if (options.skipMessages) console.log(`[LocalSync] Pulando sincronizacao de mensagens`);
		if (options.skipSchedules) console.log(`[LocalSync] Pulando sincronizacao de agendamentos`);

		try {
			// 1. Ensure tables exist
			await this.ensureTablesExist(instance);

			// 2. Sync contacts
			const contactsCount = options.skipContacts ? 0 : await this.syncContacts(instance);

			// 3. Sync contact sectors
			const sectorsCount = options.skipSectors ? 0 : await this.syncContactSectors(instance);

			// 4. Sync chats
			const chatsCount = options.skipChats ? 0 : await this.syncChats(instance);

			// 5. Sync messages
			const messagesCount = options.skipMessages ? 0 : await this.syncMessages(instance);

			// 6. Sync schedules
			const schedulesCount = options.skipSchedules ? 0 : await this.syncSchedules(instance);

			console.log(`[LocalSync] ====== Sincronizacao concluida para: ${instance} ======`);
			console.log(
				`[LocalSync] Resumo: ${contactsCount} contatos, ${sectorsCount} setores, ${chatsCount} chats, ${messagesCount} mensagens, ${schedulesCount} agendamentos`
			);
		} catch (error) {
			console.error(`[LocalSync] Erro ao sincronizar instancia ${instance}:`, error);
			throw error;
		}
	}

	/**
	 * Run full synchronization for all instances
	 */
	public async syncAllInstances(options: SyncOptions = {}): Promise<void> {
		console.log(`[LocalSync] Iniciando sincronizacao de todas as instancias`);

		try {
			// Get all unique instances
			const instances = await prismaService.wppContact.findMany({
				select: { instance: true },
				distinct: ["instance"]
			});

			const uniqueInstances = instances.map((i) => i.instance);

			console.log(`[LocalSync] Encontradas ${uniqueInstances.length} instancias para sincronizar`);

			for (const instance of uniqueInstances) {
				await this.syncInstance(instance, options);
			}

			console.log(`[LocalSync] Sincronizacao de todas as instancias concluida`);
		} catch (error) {
			console.error(`[LocalSync] Erro ao sincronizar todas as instancias:`, error);
			throw error;
		}
	}

	public async ensureLocalTables(instance: string): Promise<void> {
		await this.ensureTablesExist(instance);
	}
}

export default new LocalSyncService();
