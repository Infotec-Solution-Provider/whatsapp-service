import { safeEncode } from "../utils/safe-encode";
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
	 * Ensure all required local tables exist in the tenant database
	 */
	private async ensureTablesExist(instance: string): Promise<void> {
		console.log(`[LocalSync] Verificando tabelas no banco do tenant: ${instance}`);

		// Create migrations table first
		const createMigrationsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_sync_migrations (
				id VARCHAR(255) PRIMARY KEY,
				description TEXT NOT NULL,
				executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
				INDEX idx_executed_at (executed_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

		// Create sync state table to track last synced IDs
		const createSyncStateTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_sync_state (
				entity VARCHAR(50) PRIMARY KEY,
				last_synced_id INT NOT NULL DEFAULT 0,
				last_synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
				INDEX idx_last_synced_at (last_synced_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8;
		`;

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
				bot_id INT NULL,
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
				file_name LONGTEXT NULL,
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

		const createLastMessagesTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_last_messages (
				instance VARCHAR(255) NOT NULL,
				contact_id INT NOT NULL,
				chat_id INT NULL,
				message_id INT NOT NULL,
				\`from\` VARCHAR(255) NOT NULL,
				\`to\` VARCHAR(255) NOT NULL,
				type VARCHAR(50) NOT NULL,
				body LONGTEXT NOT NULL,
				timestamp VARCHAR(64) NOT NULL,
				sent_at DATETIME NOT NULL,
				status VARCHAR(50) NOT NULL,
				file_id INT NULL,
				file_name LONGTEXT NULL,
				file_type VARCHAR(255) NULL,
				file_size VARCHAR(255) NULL,
				user_id INT NULL,
				billing_category VARCHAR(255) NULL,
				client_id INT NULL,
				PRIMARY KEY (instance, contact_id),
				INDEX idx_chat_id (chat_id),
				INDEX idx_sent_at (sent_at)
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
			await instancesService.executeQuery(instance, createMigrationsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_sync_migrations verificada/criada`);

			await instancesService.executeQuery(instance, createSyncStateTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_sync_state verificada/criada`);

			await instancesService.executeQuery(instance, createContactsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contacts verificada/criada`);

			await instancesService.executeQuery(instance, createContactSectorsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contact_sectors verificada/criada`);

			await instancesService.executeQuery(instance, createChatsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_chats verificada/criada`);

			await instancesService.executeQuery(instance, createMessagesTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_messages verificada/criada`);

			await instancesService.executeQuery(instance, createLastMessagesTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_last_messages verificada/criada`);

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

			// Run migrations
			await this.runMigrations(instance);

			try {
				const alterLastMessagesQuery = `ALTER TABLE wpp_last_messages CONVERT TO CHARACTER SET utf8`;
				await instancesService.executeQuery(instance, alterLastMessagesQuery, []);
				console.log(`[LocalSync] Charset de wpp_last_messages alterado para utf8`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] wpp_last_messages charset já é utf8 ou erro ao alterar`);
				}
			}

			try {
				const backfillLastMessagesQuery = `
					INSERT INTO wpp_last_messages (
						instance, contact_id, chat_id, message_id, \`from\`, \`to\`, type, body,
						timestamp, sent_at, status, file_id, file_name, file_type, file_size,
						user_id, billing_category, client_id
					)
					SELECT
						m.instance,
						m.contact_id,
						m.chat_id,
						m.id,
						m.\`from\`,
						m.\`to\`,
						m.type,
						m.body,
						m.timestamp,
						m.sent_at,
						m.status,
						m.file_id,
						m.file_name,
						m.file_type,
						m.file_size,
						m.user_id,
						m.billing_category,
						m.client_id
					FROM wpp_messages m
					INNER JOIN (
						SELECT contact_id, MAX(sent_at) AS max_sent_at
						FROM wpp_messages
						WHERE instance = ? AND contact_id IS NOT NULL
						GROUP BY contact_id
					) lm ON lm.contact_id = m.contact_id AND lm.max_sent_at = m.sent_at
					WHERE m.instance = ? AND m.contact_id IS NOT NULL
					ON DUPLICATE KEY UPDATE
						message_id = IF(VALUES(sent_at) >= sent_at, VALUES(message_id), message_id),
						chat_id = IF(VALUES(sent_at) >= sent_at, VALUES(chat_id), chat_id),
						\`from\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`from\`), \`from\`),
						\`to\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`to\`), \`to\`),
						type = IF(VALUES(sent_at) >= sent_at, VALUES(type), type),
						body = IF(VALUES(sent_at) >= sent_at, VALUES(body), body),
						timestamp = IF(VALUES(sent_at) >= sent_at, VALUES(timestamp), timestamp),
						sent_at = IF(VALUES(sent_at) >= sent_at, VALUES(sent_at), sent_at),
						status = IF(VALUES(sent_at) >= sent_at, VALUES(status), status),
						file_id = IF(VALUES(sent_at) >= sent_at, VALUES(file_id), file_id),
						file_name = IF(VALUES(sent_at) >= sent_at, VALUES(file_name), file_name),
						file_type = IF(VALUES(sent_at) >= sent_at, VALUES(file_type), file_type),
						file_size = IF(VALUES(sent_at) >= sent_at, VALUES(file_size), file_size),
						user_id = IF(VALUES(sent_at) >= sent_at, VALUES(user_id), user_id),
						billing_category = IF(VALUES(sent_at) >= sent_at, VALUES(billing_category), billing_category),
						client_id = IF(VALUES(sent_at) >= sent_at, VALUES(client_id), client_id)
				`;
				await instancesService.executeQuery(instance, backfillLastMessagesQuery, [instance, instance]);
				console.log(`[LocalSync] Backfill de wpp_last_messages concluído`);
			} catch (err: any) {
				console.log(`[LocalSync] Erro ao fazer backfill de wpp_last_messages: ${err.message}`);
			}

			try {
				const alterFileNameQuery = `ALTER TABLE wpp_messages MODIFY COLUMN file_name LONGTEXT NULL`;
				await instancesService.executeQuery(instance, alterFileNameQuery, []);
				console.log(`[LocalSync] Coluna file_name de wpp_messages alterada para LONGTEXT`);
			} catch (err: any) {
				if (!err.message.includes("already exists")) {
					console.log(`[LocalSync] file_name já é LONGTEXT ou erro ao alterar`);
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
	 * Run database migrations
	 */
	private async runMigrations(instance: string): Promise<void> {
		console.log(`[LocalSync] Executando migrations para: ${instance}`);

		const migrations = [
			{
				id: '2026-02-03-001-add-bot-id-column',
				description: 'Add bot_id column to wpp_chats table',
				up: async () => {
					const checkBotIdQuery = `
						SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
						WHERE TABLE_NAME = 'wpp_chats' AND COLUMN_NAME = 'bot_id'
					`;
					const columnExists = await instancesService.executeQuery<any[]>(instance, checkBotIdQuery, []);
					if (!columnExists || columnExists.length === 0) {
						const addBotIdQuery = `ALTER TABLE wpp_chats ADD COLUMN bot_id INT NULL AFTER sector_id`;
						await instancesService.executeQuery(instance, addBotIdQuery, []);
					}
				}
			}
		];

		for (const migration of migrations) {
			try {
				// Check if migration already ran
				const checkQuery = `SELECT id FROM wpp_sync_migrations WHERE id = ?`;
				const existing = await instancesService.executeQuery<any[]>(instance, checkQuery, [migration.id]);

				if (existing && existing.length > 0) {
					console.log(`[LocalSync] Migration ${migration.id} já executada, pulando...`);
					continue;
				}

				console.log(`[LocalSync] Executando migration: ${migration.id}`);
				await migration.up();

				// Record migration as executed
				const insertQuery = `INSERT INTO wpp_sync_migrations (id, description) VALUES (?, ?)`;
				await instancesService.executeQuery(instance, insertQuery, [migration.id, migration.description]);
				console.log(`[LocalSync] Migration ${migration.id} executada com sucesso`);
			} catch (err: any) {
				if (err.message.includes("Duplicate column name") || err.message.includes("Duplicate entry")) {
					console.log(`[LocalSync] Migration ${migration.id} já aplicada (coluna/entrada duplicada)`);
					// Record as executed even if column already exists
					try {
						const insertQuery = `INSERT INTO wpp_sync_migrations (id, description) VALUES (?, ?)`;
						await instancesService.executeQuery(instance, insertQuery, [migration.id, migration.description]);
					} catch (insertErr) {
						// Ignore duplicate entry error for migration record
					}
				} else {
					console.error(`[LocalSync] Erro ao executar migration ${migration.id}:`, err.message);
					throw err;
				}
			}
		}
	}

	/**
	 * Get or initialize sync state for an entity
	 */
	private async getSyncState(instance: string, entity: string): Promise<number> {
		try {
			const query = `SELECT last_synced_id FROM wpp_sync_state WHERE entity = ?`;
			const result = await instancesService.executeQuery<any[]>(instance, query, [entity]);
			
			if (result && result.length > 0) {
				return result[0].last_synced_id || 0;
			}
			
			// Initialize if doesn't exist
			const insertQuery = `INSERT INTO wpp_sync_state (entity, last_synced_id) VALUES (?, 0)`;
			await instancesService.executeQuery(instance, insertQuery, [entity]);
			return 0;
		} catch (err) {
			console.error(`[LocalSync] Erro ao obter sync state para ${entity}:`, err);
			return 0;
		}
	}

	/**
	 * Update sync state for an entity
	 */
	private async updateSyncState(instance: string, entity: string, lastSyncedId: number): Promise<void> {
		try {
			const query = `
				INSERT INTO wpp_sync_state (entity, last_synced_id) 
				VALUES (?, ?)
				ON DUPLICATE KEY UPDATE last_synced_id = VALUES(last_synced_id)
			`;
			await instancesService.executeQuery(instance, query, [entity, lastSyncedId]);
		} catch (err) {
			console.error(`[LocalSync] Erro ao atualizar sync state para ${entity}:`, err);
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
	 * Sync chats from Prisma to local database (incremental)
	 */
	private async syncChats(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando chats para: ${instance}`);

		// Get last synced chat ID
		const lastSyncedId = await this.getSyncState(instance, 'chats');
		console.log(`[LocalSync] Último ID de chat sincronizado: ${lastSyncedId}`);

		const chats = await prismaService.wppChat.findMany({
			where: { 
				instance,
				id: { gt: lastSyncedId }
			},
			orderBy: { id: 'asc' }
		});

		if (chats.length === 0) {
			console.log(`[LocalSync] Nenhum chat encontrado para sincronizar`);
			return 0;
		}

		const batchSize = 100;
		let syncedCount = 0;

		for (let i = 0; i < chats.length; i += batchSize) {
			const batch = chats.slice(i, i + batchSize);

			// Create placeholders for 15 fields per chat
			const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(", ");

			// Flatten all values
			const values: any[] = [];
			batch.forEach((chat) => {
				values.push(
					chat.id,
					chat.id, // original_id
					chat.instance,
					chat.type,
					safeEncode(chat.avatarUrl),
					chat.userId,
					chat.contactId,
					chat.sectorId,
					chat.botId,
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
					sector_id, bot_id, started_at, finished_at, finished_by,
					result_id, is_finished, is_schedule
				)
				VALUES ${placeholders}
				ON DUPLICATE KEY UPDATE
					type = VALUES(type),
					avatar_url = VALUES(avatar_url),
					user_id = VALUES(user_id),
					contact_id = VALUES(contact_id),
					sector_id = VALUES(sector_id),
					bot_id = VALUES(bot_id),
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
		// Update sync state with the highest ID processed
		if (chats.length > 0) {
			const maxId = chats.reduce((max, chat) => Math.max(max, chat.id), 0);
			await this.updateSyncState(instance, 'chats', maxId);
			console.log(`[LocalSync] Sync state atualizado para chats: ${maxId}`);
		}
		console.log(`[LocalSync] ${syncedCount} chats sincronizados`);
		return syncedCount;
	}

	/**
	 * Sync messages from Prisma to local database (incremental)
	 */
	private async syncMessages(instance: string): Promise<number> {
		console.log(`[LocalSync] Sincronizando mensagens para: ${instance}`);

		// Get last synced message ID
		const lastSyncedId = await this.getSyncState(instance, 'messages');
		console.log(`[LocalSync] Último ID de mensagem sincronizado: ${lastSyncedId}`);

		const messages = await prismaService.wppMessage.findMany({
			where: { 
				instance,
				id: { gt: lastSyncedId }
			},
			orderBy: { id: 'asc' }
		});

		if (messages.length === 0) {
			console.log(`[LocalSync] Nenhuma mensagem encontrada para sincronizar`);
			return 0;
		}

		let syncedCount = 0;
		let errorCount = 0;

		const isInvalidAddress = (value: string | null | undefined) => {
			if (value === null || value === undefined) return true;
			const normalized = String(value).trim();
			return normalized === "" || normalized === "0";
		};

		const validMessages = messages.filter((msg) => !isInvalidAddress(msg?.from) && !isInvalidAddress(msg?.to));
		const skippedCount = messages.length - validMessages.length;
		if (skippedCount > 0) {
			console.log(`[LocalSync] ${skippedCount} mensagens ignoradas por from/to inválidos`);
		}

		const batchSize = 500;
		for (let i = 0; i < validMessages.length; i += batchSize) {
			const batch = validMessages.slice(i, i + batchSize);

			const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").join(", ");
			const values: any[] = [];
			batch.forEach((msg) => {
				values.push(
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
					safeEncode(msg.body) || "",
					msg.timestamp,
					this.formatDateForMySQL(msg.sentAt),
					msg.status,
					msg.fileId,
					safeEncode(msg.fileName),
					msg.fileType,
					msg.fileSize,
					msg.userId,
					msg.billingCategory,
					msg.clientId
				);
			});

			const query = `
				INSERT INTO wpp_messages (
					id, instance, wwebjs_id, wwebjs_id_stanza, waba_id, gupshup_id, gupshup_request_id,
					\`from\`, \`to\`, type, quoted_id, chat_id, contact_id, is_forwarded, is_edited,
					body, timestamp, sent_at, status, file_id, file_name, file_type, file_size,
					user_id, billing_category, client_id
				)
				VALUES ${placeholders}
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

			try {
				await instancesService.executeQuery(instance, query, values);

				const lastMessagesBatch = batch.filter((msg) => typeof msg.contactId === "number");
				if (lastMessagesBatch.length) {
					const lastPlaceholders = lastMessagesBatch
						.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
						.join(", ");
					const lastValues: any[] = [];
					lastMessagesBatch.forEach((msg) => {
						const sentAtValue =
							this.formatDateForMySQL(msg.sentAt) || this.formatDateForMySQL(new Date(0));
						lastValues.push(
							msg.instance,
							msg.contactId,
							msg.chatId,
							msg.id,
							msg.from,
							msg.to,
							msg.type,
							safeEncode(msg.body) || "",
							msg.timestamp,
							sentAtValue,
							msg.status,
							msg.fileId,
							safeEncode(msg.fileName),
							msg.fileType,
							msg.fileSize,
							msg.userId,
							msg.billingCategory,
							msg.clientId
						);
					});

					const lastQuery = `
						INSERT INTO wpp_last_messages (
							instance, contact_id, chat_id, message_id, \`from\`, \`to\`, type, body,
							timestamp, sent_at, status, file_id, file_name, file_type, file_size,
							user_id, billing_category, client_id
						)
						VALUES ${lastPlaceholders}
						ON DUPLICATE KEY UPDATE
							message_id = IF(VALUES(sent_at) >= sent_at, VALUES(message_id), message_id),
							chat_id = IF(VALUES(sent_at) >= sent_at, VALUES(chat_id), chat_id),
							\`from\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`from\`), \`from\`),
							\`to\` = IF(VALUES(sent_at) >= sent_at, VALUES(\`to\`), \`to\`),
							type = IF(VALUES(sent_at) >= sent_at, VALUES(type), type),
							body = IF(VALUES(sent_at) >= sent_at, VALUES(body), body),
							timestamp = IF(VALUES(sent_at) >= sent_at, VALUES(timestamp), timestamp),
							sent_at = IF(VALUES(sent_at) >= sent_at, VALUES(sent_at), sent_at),
							status = IF(VALUES(sent_at) >= sent_at, VALUES(status), status),
							file_id = IF(VALUES(sent_at) >= sent_at, VALUES(file_id), file_id),
							file_name = IF(VALUES(sent_at) >= sent_at, VALUES(file_name), file_name),
							file_type = IF(VALUES(sent_at) >= sent_at, VALUES(file_type), file_type),
							file_size = IF(VALUES(sent_at) >= sent_at, VALUES(file_size), file_size),
							user_id = IF(VALUES(sent_at) >= sent_at, VALUES(user_id), user_id),
							billing_category = IF(VALUES(sent_at) >= sent_at, VALUES(billing_category), billing_category),
							client_id = IF(VALUES(sent_at) >= sent_at, VALUES(client_id), client_id)
					`;

					await instancesService.executeQuery(instance, lastQuery, lastValues);
				}

				syncedCount += batch.length;
				if (syncedCount % 500 === 0 || syncedCount === validMessages.length) {
					console.log(`[LocalSync] Progresso: ${syncedCount}/${validMessages.length} mensagens sincronizadas`);
				}
			} catch (err: any) {
				errorCount++;
				const batchStart = i + 1;
				const batchEnd = Math.min(i + batch.length, validMessages.length);
				console.error(`[LocalSync] Erro ao sincronizar batch de mensagens (${batchStart}-${batchEnd}): ${err.message}`);
				if (errorCount >= 10) {
					console.error(`[LocalSync] ABORTANDO: Muitos erros consecutivos (${errorCount})`);
					throw err;
				}
			}
		}

		// Update sync state with the highest ID processed
		if (validMessages.length > 0) {
			const maxId = validMessages.reduce((max, msg) => Math.max(max, msg.id), 0);
			await this.updateSyncState(instance, 'messages', maxId);
			console.log(`[LocalSync] Sync state atualizado para messages: ${maxId}`);
		}

		console.log(
			`[LocalSync] ${syncedCount} mensagens sincronizadas (${errorCount} erros, ${skippedCount} ignoradas)`
		);
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
					safeEncode(schedule.description),
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

	/**
	 * Reset sync state for an entity (forces full resync on next run)
	 */
	public async resetSyncState(instance: string, entity: 'messages' | 'chats' | 'all'): Promise<void> {
		try {
			if (entity === 'all') {
				const query = `DELETE FROM wpp_sync_state`;
				await instancesService.executeQuery(instance, query, []);
				console.log(`[LocalSync] Sync state resetado para todas as entidades`);
			} else {
				const query = `DELETE FROM wpp_sync_state WHERE entity = ?`;
				await instancesService.executeQuery(instance, query, [entity]);
				console.log(`[LocalSync] Sync state resetado para ${entity}`);
			}
		} catch (err) {
			console.error(`[LocalSync] Erro ao resetar sync state:`, err);
			throw err;
		}
	}

	/**
	 * Get sync status for an instance
	 */
	public async getSyncStatus(instance: string): Promise<{
		migrations: Array<{ id: string; description: string; executed_at: Date }>;
		syncState: Array<{ entity: string; last_synced_id: number; last_synced_at: Date }>;
	}> {
		try {
			const migrationsQuery = `SELECT id, description, executed_at FROM wpp_sync_migrations ORDER BY executed_at DESC`;
			const migrations = await instancesService.executeQuery<any[]>(instance, migrationsQuery, []);

			const syncStateQuery = `SELECT entity, last_synced_id, last_synced_at FROM wpp_sync_state ORDER BY entity`;
			const syncState = await instancesService.executeQuery<any[]>(instance, syncStateQuery, []);

			return {
				migrations: migrations || [],
				syncState: syncState || []
			};
		} catch (err) {
			console.error(`[LocalSync] Erro ao obter sync status:`, err);
			return { migrations: [], syncState: [] };
		}
	}

	/**
	 * Force full resync by clearing data and state
	 */
	public async forceFullResync(instance: string): Promise<void> {
		console.log(`[LocalSync] Iniciando full resync para ${instance}...`);
		
		try {
			// Clear sync state
			await this.resetSyncState(instance, 'all');

			// Optionally clear existing data (commented out for safety)
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_contacts', []);
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_contact_sectors', []);
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_chats', []);
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_messages', []);
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_last_messages', []);
			// await instancesService.executeQuery(instance, 'TRUNCATE TABLE wpp_schedules', []);

			console.log(`[LocalSync] Sync state limpo. Execute syncInstance() para resincronizar tudo.`);
		} catch (err) {
			console.error(`[LocalSync] Erro ao forçar full resync:`, err);
			throw err;
		}
	}
}

export default new LocalSyncService();
