import instancesService from "./instances.service";
import prismaService from "./prisma.service";

class LocalSyncService {
	/**
	 * Escape string for SQL queries
	 */
	private escapeSQL(value: string): string {
		if (value === null || value === undefined) {
			return "NULL";
		}
		return "'" + value.toString().replace(/'/g, "''").replace(/\\/g, "\\\\") + "'";
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
			) ENGINE=InnoDB DEFAULT CHARSET=latin1;
		`;

		const createContactSectorsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_contact_sectors (
				contact_id INT NOT NULL,
				sector_id INT NOT NULL,
				PRIMARY KEY (contact_id, sector_id),
				INDEX idx_sector_id (sector_id)
			) ENGINE=InnoDB DEFAULT CHARSET=latin1;
		`;

		const createChatsTableQuery = `
			CREATE TABLE IF NOT EXISTS wpp_chats (
				id INT AUTO_INCREMENT PRIMARY KEY,
				original_id INT NOT NULL UNIQUE,
				instance VARCHAR(255) NOT NULL,
				type VARCHAR(50) NOT NULL,
				avatar_url TEXT NULL,
				user_id INT NULL,
				contact_id INT NOT NULL,
				sector_id INT NULL,
				started_at DATETIME NOT NULL,
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
			) ENGINE=InnoDB DEFAULT CHARSET=latin1;
		`;

		try {
			await instancesService.executeQuery(instance, createContactsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contacts verificada/criada`);

			await instancesService.executeQuery(instance, createContactSectorsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_contact_sectors verificada/criada`);

			await instancesService.executeQuery(instance, createChatsTableQuery, []);
			console.log(`[LocalSync] Tabela wpp_chats verificada/criada`);

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

			const values = batch
				.map(
					(c) =>
						`(${c.id}, ${this.escapeSQL(c.instance)}, ${this.escapeSQL(c.name)}, ${this.escapeSQL(c.phone)}, ${c.customerId || "NULL"}, ${c.isDeleted ? 1 : 0})`
				)
				.join(", ");

			const query = `
				INSERT INTO wpp_contacts (id, instance, name, phone, customer_id, is_deleted)
				VALUES ${values}
				ON DUPLICATE KEY UPDATE
					name = VALUES(name),
					phone = VALUES(phone),
					customer_id = VALUES(customer_id),
					is_deleted = VALUES(is_deleted)
			`;

			await instancesService.executeQuery(instance, query, []);
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
			const values = batch.map((rel) => `(${rel.contactId}, ${rel.sectorId})`).join(", ");

			const query = `
				INSERT INTO wpp_contact_sectors (contact_id, sector_id)
				VALUES ${values}
			`;

			await instancesService.executeQuery(instance, query, []);
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

			const values = batch
				.map((chat) => {
					const startedAt = this.formatDateForMySQL(chat.startedAt);
					const finishedAt = this.formatDateForMySQL(chat.finishedAt);
					const avatarUrl = chat.avatarUrl ? this.escapeSQL(chat.avatarUrl) : "NULL";

					return `(${chat.id}, ${chat.id}, ${this.escapeSQL(chat.instance)}, ${this.escapeSQL(chat.type)}, ${avatarUrl}, ${chat.userId || "NULL"}, ${chat.contactId}, ${chat.sectorId || "NULL"}, ${startedAt}, ${finishedAt}, ${chat.finishedBy || "NULL"}, ${chat.resultId || "NULL"}, ${chat.isFinished ? 1 : 0}, ${chat.isSchedule ? 1 : 0})`;
				})
				.join(", ");

			const query = `
				INSERT INTO wpp_chats (
					id, original_id, instance, type, avatar_url, user_id, contact_id,
					sector_id, started_at, finished_at, finished_by,
					result_id, is_finished, is_schedule
				)
				VALUES ${values}
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
				await instancesService.executeQuery(instance, query, []);
				syncedCount += batch.length;
			} catch (err) {
				console.error(`[LocalSync] Erro ao sincronizar batch de chats:`, err);
				console.error(`[LocalSync] Query: ${query.substring(0, 500)}...`);
				throw err;
			}
		}

		console.log(`[LocalSync] ${syncedCount} chats sincronizados`);
		return syncedCount;
	}

	/**
	 * Format date to MySQL datetime format (YYYY-MM-DD HH:MM:SS)
	 * Returns NULL literal (without quotes) for use in raw SQL strings
	 */
	private formatDateForMySQL(date: Date | null | undefined): string {
		if (!date) return "NULL";
		
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, "0");
		const day = String(date.getDate()).padStart(2, "0");
		const hours = String(date.getHours()).padStart(2, "0");
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const seconds = String(date.getSeconds()).padStart(2, "0");

		return `'${year}-${month}-${day} ${hours}:${minutes}:${seconds}'`;
	}

	/**
	 * Run full synchronization for a specific instance
	 */
	public async syncInstance(instance: string): Promise<void> {
		console.log(`[LocalSync] ====== Iniciando sincronizacao para: ${instance} ======`);

		try {
			// 1. Ensure tables exist
			await this.ensureTablesExist(instance);

			// 2. Sync contacts
			const contactsCount = await this.syncContacts(instance);

			// 3. Sync contact sectors
			const sectorsCount = await this.syncContactSectors(instance);

			// 4. Sync chats
			const chatsCount = await this.syncChats(instance);

			console.log(`[LocalSync] ====== Sincronizacao concluida para: ${instance} ======`);
			console.log(`[LocalSync] Resumo: ${contactsCount} contatos, ${sectorsCount} setores, ${chatsCount} chats`);
		} catch (error) {
			console.error(`[LocalSync] Erro ao sincronizar instancia ${instance}:`, error);
			throw error;
		}
	}

	/**
	 * Run full synchronization for all instances
	 */
	public async syncAllInstances(): Promise<void> {
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
				await this.syncInstance(instance);
			}

			console.log(`[LocalSync] Sincronizacao de todas as instancias concluida`);
		} catch (error) {
			console.error(`[LocalSync] Erro ao sincronizar todas as instancias:`, error);
			throw error;
		}
	}
}

export default new LocalSyncService();
