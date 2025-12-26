import {
  WppChat,
  WppContact,
  WppMessage,
  WppSchedule,
  InternalChat,
  InternalMessage,
  InternalChatMember,
  InternalMention
} from "@prisma/client";
import instancesService from "./instances.service";
import prismaService from "./prisma.service";import parametersService from "./parameters.service";

// ===== Helper para verificar e sincronizar =====
async function shouldSync(instance: string): Promise<boolean> {
  const useLocalDB = await parametersService.getParameter(instance, "use-local-database");
  return useLocalDB === "true";
}

// Wrappers que verificam o parâmetro automaticamente
export async function syncContact(instance: string, contact: WppContact) {
  if (await shouldSync(instance)) {
    await upsertContactOnLocalDatabase(instance, contact);
  }
}

export async function syncDeleteContact(instance: string, contactId: number) {
  if (await shouldSync(instance)) {
    await deleteContactOnLocalDatabase(instance, contactId);
  }
}

export async function syncChat(instance: string, chat: WppChat) {
  if (await shouldSync(instance)) {
    await upsertChatOnLocalDatabase(instance, chat);
  }
}

export async function syncDeleteChat(instance: string, chatId: number) {
  if (await shouldSync(instance)) {
    await deleteChatOnLocalDatabase(instance, chatId);
  }
}

export async function syncMessage(instance: string, message: WppMessage) {
  if (await shouldSync(instance)) {
    await upsertMessageOnLocalDatabase(instance, message);
  }
}

export async function syncDeleteMessage(instance: string, messageId: number) {
  if (await shouldSync(instance)) {
    await deleteMessageOnLocalDatabase(instance, messageId);
  }
}

export async function syncSchedule(instance: string, schedule: WppSchedule) {
  if (await shouldSync(instance)) {
    await upsertScheduleOnLocalDatabase(instance, schedule);
  }
}

export async function syncDeleteSchedule(instance: string, scheduleId: number) {
  if (await shouldSync(instance)) {
    await deleteScheduleOnLocalDatabase(instance, scheduleId);
  }
}

export async function syncInternalChat(instance: string, chat: InternalChat) {
  if (await shouldSync(instance)) {
    await upsertInternalChatOnLocalDatabase(instance, chat);
  }
}

export async function syncDeleteInternalChat(instance: string, chatId: number) {
  if (await shouldSync(instance)) {
    await deleteInternalChatOnLocalDatabase(instance, chatId);
  }
}

export async function syncInternalMessage(instance: string, message: InternalMessage) {
  if (await shouldSync(instance)) {
    await upsertInternalMessageOnLocalDatabase(instance, message);
  }
}

export async function syncDeleteInternalMessage(instance: string, messageId: number) {
  if (await shouldSync(instance)) {
    await deleteInternalMessageOnLocalDatabase(instance, messageId);
  }
}

export async function syncInternalChatMember(instance: string, member: InternalChatMember) {
  if (await shouldSync(instance)) {
    await upsertInternalChatMemberOnLocalDatabase(instance, member);
  }
}

export async function syncDeleteInternalChatMember(instance: string, internalChatId: number, userId: number) {
  if (await shouldSync(instance)) {
    await deleteInternalChatMemberOnLocalDatabase(instance, internalChatId, userId);
  }
}

export async function syncInternalMention(instance: string, mention: InternalMention) {
  if (await shouldSync(instance)) {
    await upsertInternalMentionOnLocalDatabase(instance, mention);
  }
}

export async function syncDeleteInternalMention(instance: string, mentionId: number) {
  if (await shouldSync(instance)) {
    await deleteInternalMentionOnLocalDatabase(instance, mentionId);
  }
}
// ===== WppContact =====
export async function upsertContactOnLocalDatabase(instance: string, contact: WppContact) {
  const query = `INSERT INTO contacts (id, instance, name, phone, customer_id, is_deleted, is_blocked, is_only_admin, avatar_url, created_at, updated_at, last_out_of_hours_reply_sent_at, conversation_expiration)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            phone = VALUES(phone),
            customer_id = VALUES(customer_id),
            is_deleted = VALUES(is_deleted),
            is_blocked = VALUES(is_blocked),
            is_only_admin = VALUES(is_only_admin),
            avatar_url = VALUES(avatar_url),
            updated_at = VALUES(updated_at),
            last_out_of_hours_reply_sent_at = VALUES(last_out_of_hours_reply_sent_at),
            conversation_expiration = VALUES(conversation_expiration)`;

  const values = [
    contact.id,
    contact.instance,
    contact.name,
    contact.phone,
    contact.customerId,
    contact.isDeleted ? 1 : 0,
    contact.isBlocked ? 1 : 0,
    contact.isOnlyAdmin ? 1 : 0,
    contact.avatarUrl,
    contact.createdAt,
    contact.updatedAt,
    contact.lastOutOfHoursReplySentAt,
    contact.conversationExpiration
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "contact",
        entityId: contact.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteContactOnLocalDatabase(instance: string, contactId: number) {
  const query = `DELETE FROM contacts WHERE id = ?`;
  const values = [contactId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "contact",
        entityId: contactId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== WppChat =====
export async function upsertChatOnLocalDatabase(instance: string, chat: WppChat) {
  const query = `INSERT INTO chats (id, instance, contact_id, user_id, wallet_id, bot_id, result_id, sector_id, schedule_id, type, priority, avatar_url, is_finished, started_at, finished_at, finished_by, is_schedule)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            contact_id = VALUES(contact_id),
            user_id = VALUES(user_id),
            wallet_id = VALUES(wallet_id),
            bot_id = VALUES(bot_id),
            result_id = VALUES(result_id),
            sector_id = VALUES(sector_id),
            schedule_id = VALUES(schedule_id),
            type = VALUES(type),
            priority = VALUES(priority),
            avatar_url = VALUES(avatar_url),
            is_finished = VALUES(is_finished),
            started_at = VALUES(started_at),
            finished_at = VALUES(finished_at),
            finished_by = VALUES(finished_by),
            is_schedule = VALUES(is_schedule)`;

  const values = [
    chat.id,
    chat.instance,
    chat.contactId,
    chat.userId,
    chat.walletId,
    chat.botId,
    chat.resultId,
    chat.sectorId,
    chat.scheduleId,
    chat.type,
    chat.priority,
    chat.avatarUrl,
    chat.isFinished ? 1 : 0,
    chat.startedAt,
    chat.finishedAt,
    chat.finishedBy,
    chat.isSchedule ? 1 : 0
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "chat",
        entityId: chat.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteChatOnLocalDatabase(instance: string, chatId: number) {
  const query = `DELETE FROM chats WHERE id = ?`;
  const values = [chatId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "chat",
        entityId: chatId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== WppMessage =====
export async function upsertMessageOnLocalDatabase(instance: string, message: WppMessage) {
  const query = `INSERT INTO messages (id, instance, wwebjs_id, wwebjs_id_stanza, waba_id, gupshup_id, gupshup_request_id, from, to, type, quoted_id, chat_id, contact_id, is_forwarded, is_edited, body, timestamp, sent_at, status, file_id, file_name, file_type, file_size, user_id, billing_category, client_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            wwebjs_id = VALUES(wwebjs_id),
            wwebjs_id_stanza = VALUES(wwebjs_id_stanza),
            waba_id = VALUES(waba_id),
            gupshup_id = VALUES(gupshup_id),
            gupshup_request_id = VALUES(gupshup_request_id),
            from = VALUES(from),
            to = VALUES(to),
            type = VALUES(type),
            quoted_id = VALUES(quoted_id),
            chat_id = VALUES(chat_id),
            contact_id = VALUES(contact_id),
            is_forwarded = VALUES(is_forwarded),
            is_edited = VALUES(is_edited),
            body = VALUES(body),
            status = VALUES(status),
            file_id = VALUES(file_id),
            file_name = VALUES(file_name),
            file_type = VALUES(file_type),
            file_size = VALUES(file_size),
            user_id = VALUES(user_id),
            billing_category = VALUES(billing_category),
            client_id = VALUES(client_id)`;

  const values = [
    message.id,
    message.instance,
    message.wwebjsId,
    message.wwebjsIdStanza,
    message.wabaId,
    message.gupshupId,
    message.gupshupRequestId,
    message.from,
    message.to,
    message.type,
    message.quotedId,
    message.chatId,
    message.contactId,
    message.isForwarded ? 1 : 0,
    message.isEdited ? 1 : 0,
    message.body,
    message.timestamp,
    message.sentAt,
    message.status,
    message.fileId,
    message.fileName,
    message.fileType,
    message.fileSize,
    message.userId,
    message.billingCategory,
    message.clientId
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "message",
        entityId: message.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteMessageOnLocalDatabase(instance: string, messageId: number) {
  const query = `DELETE FROM messages WHERE id = ?`;
  const values = [messageId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "message",
        entityId: messageId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== WppSchedule =====
export async function upsertScheduleOnLocalDatabase(instance: string, schedule: WppSchedule) {
  const query = `INSERT INTO schedules (id, instance, description, contact_id, chat_id, scheduled_at, schedule_date, scheduled_by, scheduled_for, sector_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            description = VALUES(description),
            contact_id = VALUES(contact_id),
            chat_id = VALUES(chat_id),
            scheduled_at = VALUES(scheduled_at),
            schedule_date = VALUES(schedule_date),
            scheduled_by = VALUES(scheduled_by),
            scheduled_for = VALUES(scheduled_for),
            sector_id = VALUES(sector_id)`;

  const values = [
    schedule.id,
    schedule.instance,
    schedule.description,
    schedule.contactId,
    schedule.chatId,
    schedule.scheduledAt,
    schedule.scheduleDate,
    schedule.scheduledBy,
    schedule.scheduledFor,
    schedule.sectorId
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "schedule",
        entityId: schedule.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteScheduleOnLocalDatabase(instance: string, scheduleId: number) {
  const query = `DELETE FROM schedules WHERE id = ?`;
  const values = [scheduleId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "schedule",
        entityId: scheduleId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== InternalChat =====
export async function upsertInternalChatOnLocalDatabase(instance: string, chat: InternalChat) {
  const query = `INSERT INTO internalchats (id, instance, user_id, sector_id, is_finished, started_at, finished_at, finished_by, is_group, group_name, group_description, group_image_file_id, wpp_group_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            user_id = VALUES(user_id),
            sector_id = VALUES(sector_id),
            is_finished = VALUES(is_finished),
            started_at = VALUES(started_at),
            finished_at = VALUES(finished_at),
            finished_by = VALUES(finished_by),
            is_group = VALUES(is_group),
            group_name = VALUES(group_name),
            group_description = VALUES(group_description),
            group_image_file_id = VALUES(group_image_file_id),
            wpp_group_id = VALUES(wpp_group_id)`;

  const values = [
    chat.id,
    chat.instance,
    chat.creatorId,
    chat.sectorId,
    chat.isFinished ? 1 : 0,
    chat.startedAt,
    chat.finishedAt,
    chat.finishedBy,
    chat.isGroup ? 1 : 0,
    chat.groupName,
    chat.groupDescription,
    chat.groupImageFileId,
    chat.wppGroupId
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_chat",
        entityId: chat.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteInternalChatOnLocalDatabase(instance: string, chatId: number) {
  const query = `DELETE FROM internalchats WHERE id = ?`;
  const values = [chatId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_chat",
        entityId: chatId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== InternalMessage =====
export async function upsertInternalMessageOnLocalDatabase(instance: string, message: InternalMessage) {
  const query = `INSERT INTO internalmessages (id, instance, from, type, quoted_id, is_forwarded, is_edited, wwebjs_id, wwebjs_id_stanza, internalchat_id, body, timestamp, status, file_id, file_name, file_type, file_size, client_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            from = VALUES(from),
            type = VALUES(type),
            quoted_id = VALUES(quoted_id),
            is_forwarded = VALUES(is_forwarded),
            is_edited = VALUES(is_edited),
            wwebjs_id = VALUES(wwebjs_id),
            wwebjs_id_stanza = VALUES(wwebjs_id_stanza),
            internalchat_id = VALUES(internalchat_id),
            body = VALUES(body),
            status = VALUES(status),
            file_id = VALUES(file_id),
            file_name = VALUES(file_name),
            file_type = VALUES(file_type),
            file_size = VALUES(file_size),
            client_id = VALUES(client_id)`;

  const values = [
    message.id,
    message.instance,
    message.from,
    message.type,
    message.quotedId,
    message.isForwarded ? 1 : 0,
    message.isEdited ? 1 : 0,
    message.wwebjsId,
    message.wwebjsIdStanza,
    message.internalChatId,
    message.body,
    message.timestamp,
    message.status,
    message.fileId,
    message.fileName,
    message.fileType,
    message.fileSize,
    message.clientId
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_message",
        entityId: message.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteInternalMessageOnLocalDatabase(instance: string, messageId: number) {
  const query = `DELETE FROM internalmessages WHERE id = ?`;
  const values = [messageId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_message",
        entityId: messageId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== InternalChatMember =====
export async function upsertInternalChatMemberOnLocalDatabase(instance: string, member: InternalChatMember) {
  const query = `INSERT INTO internal_chat_members (internalchatId, internalcontactId, joined_at, last_read_at)
            VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
            joined_at = VALUES(joined_at),
            last_read_at = VALUES(last_read_at)`;

  const values = [
    member.internalChatId,
    member.userId,
    member.joinedAt,
    member.lastReadAt
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_chat_member",
        entityId: member.internalChatId, // Usando internalChatId como ID principal
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteInternalChatMemberOnLocalDatabase(instance: string, internalChatId: number, userId: number) {
  const query = `DELETE FROM internal_chat_members WHERE internalchatId = ? AND internalcontactId = ?`;
  const values = [internalChatId, userId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_chat_member",
        entityId: internalChatId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

// ===== InternalMention =====
export async function upsertInternalMentionOnLocalDatabase(instance: string, mention: InternalMention) {
  const query = `INSERT INTO internal_mentions (id, internalmessage_id, user_id)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE
            internalmessage_id = VALUES(internalmessage_id),
            user_id = VALUES(user_id)`;

  const values = [
    mention.id,
    mention.messageId,
    mention.userId
  ];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_mention",
        entityId: mention.id,
        operation: "upsert",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}

export async function deleteInternalMentionOnLocalDatabase(instance: string, mentionId: number) {
  const query = `DELETE FROM internal_mentions WHERE id = ?`;
  const values = [mentionId];

  try {
    await instancesService.executeQuery(instance, query, values);
  } catch (error) {
    await prismaService.pendingSynchronization.create({
      data: {
        instance,
        entityType: "internal_mention",
        entityId: mentionId,
        operation: "delete",
        query,
        values: values as any,
        createdAt: new Date(),
      }
    });
  }
}