SELECT '_sector_clients' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`_sector_clients` s
  LEFT JOIN `homolog-whatsapp`.`clients` p ON p.id=s.A
  LEFT JOIN `homolog-whatsapp`.`sectors` z ON z.id=s.B
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime__sector_clients` t ON s.`A`=t.`A` AND s.`B`=t.`B`
 WHERE (IF(p.instance=z.instance,p.instance,NULL)) IS NULL OR (IF(p.instance=z.instance,p.instance,NULL)) NOT IN ('homolog','suprimaxxi') OR ((IF(p.instance=z.instance,p.instance,NULL))='suprimaxxi' AND (t.`A` IS NULL OR NOT ((BINARY s.`A` <=> BINARY t.`A`)
        AND (BINARY s.`B` <=> BINARY t.`B`))))
UNION ALL
SELECT 'contacts_sectors' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`contacts_sectors` s
  LEFT JOIN `homolog-whatsapp`.`contacts` p ON p.id=s.contactId
  LEFT JOIN `homolog-whatsapp`.`sectors` z ON z.id=s.sectorId
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_contacts_sectors` t ON s.`contactId`=t.`contactId` AND s.`sectorId`=t.`sectorId`
 WHERE (IF(p.instance=z.instance,p.instance,NULL)) IS NULL OR (IF(p.instance=z.instance,p.instance,NULL)) NOT IN ('homolog','suprimaxxi') OR ((IF(p.instance=z.instance,p.instance,NULL))='suprimaxxi' AND (t.`contactId` IS NULL OR NOT ((BINARY s.`contactId` <=> BINARY t.`contactId`)
        AND (BINARY s.`sectorId` <=> BINARY t.`sectorId`))))
UNION ALL
SELECT 'wpp_message_processing_queue' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`wpp_message_processing_queue` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_wpp_message_processing_queue` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`client_id` <=> BINARY t.`client_id`)
        AND (BINARY s.`message_id` <=> BINARY t.`message_id`)
        AND (BINARY s.`contact_phone` <=> BINARY t.`contact_phone`)
        AND (BINARY s.`contact_name` <=> BINARY t.`contact_name`)
        AND (BINARY s.`status` <=> BINARY t.`status`)
        AND (BINARY s.`retry_count` <=> BINARY t.`retry_count`)
        AND (BINARY s.`max_retries` <=> BINARY t.`max_retries`)
        AND (BINARY s.`error` <=> BINARY t.`error`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)
        AND (BINARY s.`processing_started_at` <=> BINARY t.`processing_started_at`)
        AND (BINARY s.`processed_at` <=> BINARY t.`processed_at`)
        AND (BINARY s.`locked_until` <=> BINARY t.`locked_until`)
        AND (BINARY s.`locked_by` <=> BINARY t.`locked_by`)))) OR s.status<>'COMPLETED'
UNION ALL
SELECT 'message_reactions' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`message_reactions` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_message_reactions` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`client_id` <=> BINARY t.`client_id`)
        AND (BINARY s.`target_message_id` <=> BINARY t.`target_message_id`)
        AND (BINARY s.`actor_id` <=> BINARY t.`actor_id`)
        AND (BINARY s.`from_me` <=> BINARY t.`from_me`)
        AND (BINARY s.`emoji` <=> BINARY t.`emoji`)
        AND (BINARY s.`reacted_at` <=> BINARY t.`reacted_at`)
        AND (BINARY s.`received_at` <=> BINARY t.`received_at`)
        AND (BINARY s.`source_event_id` <=> BINARY t.`source_event_id`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)
        AND (BINARY s.`internal_user_id` <=> BINARY t.`internal_user_id`)
        AND (BINARY s.`internal_user_name` <=> BINARY t.`internal_user_name`))))
UNION ALL
SELECT 'operator_outbound_send' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`operator_outbound_send` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_operator_outbound_send` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`user_id` <=> BINARY t.`user_id`)
        AND (BINARY s.`client_id` <=> BINARY t.`client_id`)
        AND (BINARY s.`idempotency_key` <=> BINARY t.`idempotency_key`)
        AND (BINARY s.`payload_hash` <=> BINARY t.`payload_hash`)
        AND (BINARY s.`payload` <=> BINARY t.`payload`)
        AND (BINARY s.`message_id` <=> BINARY t.`message_id`)
        AND (BINARY s.`delivery_mode` <=> BINARY t.`delivery_mode`)
        AND (BINARY s.`status` <=> BINARY t.`status`)
        AND (BINARY s.`remote_job_id` <=> BINARY t.`remote_job_id`)
        AND (BINARY s.`provider_outcome` <=> BINARY t.`provider_outcome`)
        AND (BINARY s.`notification_pending` <=> BINARY t.`notification_pending`)
        AND (BINARY s.`attempt_started_at` <=> BINARY t.`attempt_started_at`)
        AND (BINARY s.`attempt_count` <=> BINARY t.`attempt_count`)
        AND (BINARY s.`next_attempt_at` <=> BINARY t.`next_attempt_at`)
        AND (BINARY s.`locked_by` <=> BINARY t.`locked_by`)
        AND (BINARY s.`locked_until` <=> BINARY t.`locked_until`)
        AND (BINARY s.`error` <=> BINARY t.`error`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)
        AND (BINARY s.`completed_at` <=> BINARY t.`completed_at`)))) OR s.status<>'SENT'
UNION ALL
SELECT 'schedules' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`schedules` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_schedules` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`description` <=> BINARY t.`description`)
        AND (BINARY s.`contact_id` <=> BINARY t.`contact_id`)
        AND (BINARY s.`chat_id` <=> BINARY t.`chat_id`)
        AND (BINARY s.`scheduled_at` <=> BINARY t.`scheduled_at`)
        AND (BINARY s.`schedule_date` <=> BINARY t.`schedule_date`)
        AND (BINARY s.`scheduled_by` <=> BINARY t.`scheduled_by`)
        AND (BINARY s.`scheduled_for` <=> BINARY t.`scheduled_for`)
        AND (BINARY s.`sector_id` <=> BINARY t.`sector_id`))))
UNION ALL
SELECT 'chat_transfer_history' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`chat_transfer_history` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_chat_transfer_history` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`chat_id` <=> BINARY t.`chat_id`)
        AND (BINARY s.`from_user_id` <=> BINARY t.`from_user_id`)
        AND (BINARY s.`to_user_id` <=> BINARY t.`to_user_id`)
        AND (BINARY s.`from_sector_id` <=> BINARY t.`from_sector_id`)
        AND (BINARY s.`to_sector_id` <=> BINARY t.`to_sector_id`)
        AND (BINARY s.`initiated_by_user_id` <=> BINARY t.`initiated_by_user_id`)
        AND (BINARY s.`source` <=> BINARY t.`source`)
        AND (BINARY s.`reason` <=> BINARY t.`reason`)
        AND (BINARY s.`transferred_at` <=> BINARY t.`transferred_at`))))
UNION ALL
SELECT 'messages' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`messages` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_messages` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`wwebjs_id` <=> BINARY t.`wwebjs_id`)
        AND (BINARY s.`wwebjs_id_stanza` <=> BINARY t.`wwebjs_id_stanza`)
        AND (BINARY s.`waba_id` <=> BINARY t.`waba_id`)
        AND (BINARY s.`gupshup_id` <=> BINARY t.`gupshup_id`)
        AND (BINARY s.`gupshup_request_id` <=> BINARY t.`gupshup_request_id`)
        AND (BINARY s.`from` <=> BINARY t.`from`)
        AND (BINARY s.`to` <=> BINARY t.`to`)
        AND (BINARY s.`type` <=> BINARY t.`type`)
        AND (BINARY s.`quoted_id` <=> BINARY t.`quoted_id`)
        AND (BINARY s.`chat_id` <=> BINARY t.`chat_id`)
        AND (BINARY s.`contact_id` <=> BINARY t.`contact_id`)
        AND (BINARY s.`is_forwarded` <=> BINARY t.`is_forwarded`)
        AND (BINARY s.`is_edited` <=> BINARY t.`is_edited`)
        AND (BINARY s.`body` <=> BINARY t.`body`)
        AND (BINARY s.`timestamp` <=> BINARY t.`timestamp`)
        AND (BINARY s.`sent_at` <=> BINARY t.`sent_at`)
        AND (BINARY s.`file_id` <=> BINARY t.`file_id`)
        AND (BINARY s.`file_name` <=> BINARY t.`file_name`)
        AND (BINARY s.`file_type` <=> BINARY t.`file_type`)
        AND (BINARY s.`file_size` <=> BINARY t.`file_size`)
        AND (BINARY s.`user_id` <=> BINARY t.`user_id`)
        AND (BINARY s.`agent_id` <=> BINARY t.`agent_id`)
        AND (BINARY s.`billing_category` <=> BINARY t.`billing_category`)
        AND (BINARY s.`client_id` <=> BINARY t.`client_id`)
        AND (BINARY s.`mention_metadata` <=> BINARY t.`mention_metadata`) AND (s.status=t.status OR (s.status='RECEIVED' AND t.status='READ') OR (s.status='SENT' AND t.status='RECEIVED')))))
UNION ALL
SELECT 'chats' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`chats` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_chats` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`contact_id` <=> BINARY t.`contact_id`)
        AND (BINARY s.`wallet_id` <=> BINARY t.`wallet_id`)
        AND (BINARY s.`bot_id` <=> BINARY t.`bot_id`)
        AND (BINARY s.`agent_id` <=> BINARY t.`agent_id`)
        AND (BINARY s.`sector_id` <=> BINARY t.`sector_id`)
        AND (BINARY s.`schedule_id` <=> BINARY t.`schedule_id`)
        AND (BINARY s.`type` <=> BINARY t.`type`)
        AND (BINARY s.`priority` <=> BINARY t.`priority`)
        AND (BINARY s.`avatar_url` <=> BINARY t.`avatar_url`)
        AND (BINARY s.`started_at` <=> BINARY t.`started_at`)
        AND (BINARY s.`is_schedule` <=> BINARY t.`is_schedule`) AND ((s.is_finished=t.is_finished
        AND (BINARY s.user_id<=>BINARY t.user_id)
        AND (BINARY s.result_id<=>BINARY t.result_id)
        AND (BINARY s.finished_at<=>BINARY t.finished_at)
        AND (BINARY s.finished_by<=>BINARY t.finished_by)) OR (s.is_finished=0 AND t.is_finished=1 AND t.finished_at IS NOT NULL)))))
UNION ALL
SELECT 'wallets' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`wallets` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_wallets` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`name` <=> BINARY t.`name`)))) OR TRUE
UNION ALL
SELECT 'sectors' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`sectors` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_sectors` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`name` <=> BINARY t.`name`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`start_chats` <=> BINARY t.`start_chats`)
        AND (BINARY s.`receive_chats` <=> BINARY t.`receive_chats`)
        AND (BINARY s.`default_client_id` <=> BINARY t.`default_client_id`))))
UNION ALL
SELECT 'session_changes' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`session_changes` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_session_changes` t ON s.`instance`=t.`instance` AND s.`sequence`=t.`sequence`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`instance` IS NULL OR NOT ((BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`sequence` <=> BINARY t.`sequence`)
        AND (BINARY s.`kind` <=> BINARY t.`kind`)
        AND (BINARY s.`entity_id` <=> BINARY t.`entity_id`)
        AND (BINARY s.`chat_id` <=> BINARY t.`chat_id`)
        AND (BINARY s.`previous_user_id` <=> BINARY t.`previous_user_id`)
        AND (BINARY s.`previous_wallet_id` <=> BINARY t.`previous_wallet_id`)
        AND (BINARY s.`previous_sector_id` <=> BINARY t.`previous_sector_id`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)))) OR TRUE
UNION ALL
SELECT 'session_change_streams' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`session_change_streams` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_session_change_streams` t ON s.`instance`=t.`instance`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`instance` IS NULL OR NOT ((BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`floor_sequence` <=> BINARY t.`floor_sequence`) AND (s.epoch<>t.epoch OR t.sequence>=s.sequence))))
UNION ALL
SELECT 'waba_webhook_queue' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`waba_webhook_queue` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_waba_webhook_queue` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`payload` <=> BINARY t.`payload`)
        AND (BINARY s.`status` <=> BINARY t.`status`)
        AND (BINARY s.`retry_count` <=> BINARY t.`retry_count`)
        AND (BINARY s.`max_retries` <=> BINARY t.`max_retries`)
        AND (BINARY s.`error` <=> BINARY t.`error`)
        AND (BINARY s.`ignored_reason` <=> BINARY t.`ignored_reason`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)
        AND (BINARY s.`processing_started_at` <=> BINARY t.`processing_started_at`)
        AND (BINARY s.`processed_at` <=> BINARY t.`processed_at`)))) OR TRUE
UNION ALL
SELECT 'gupshup_webhook_queue' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`gupshup_webhook_queue` s
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_gupshup_webhook_queue` t ON s.`id`=t.`id`
 WHERE (s.instance) IS NULL OR (s.instance) NOT IN ('homolog','suprimaxxi') OR ((s.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`instance` <=> BINARY t.`instance`)
        AND (BINARY s.`payload` <=> BINARY t.`payload`)
        AND (BINARY s.`status` <=> BINARY t.`status`)
        AND (BINARY s.`retry_count` <=> BINARY t.`retry_count`)
        AND (BINARY s.`max_retries` <=> BINARY t.`max_retries`)
        AND (BINARY s.`error` <=> BINARY t.`error`)
        AND (BINARY s.`redirected` <=> BINARY t.`redirected`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)
        AND (BINARY s.`processing_started_at` <=> BINARY t.`processing_started_at`)
        AND (BINARY s.`processed_at` <=> BINARY t.`processed_at`)))) OR TRUE
UNION ALL
SELECT 'remote_inbound_event_inbox' AS tabela,COUNT(*) AS fora_do_contrato
  FROM `homolog-whatsapp`.`remote_inbound_event_inbox` s
  LEFT JOIN `homolog-whatsapp`.`clients` p ON p.id=s.client_id
  LEFT JOIN `homolog-crm-suprimaxxi`.`wpp_runtime_remote_inbound_event_inbox` t ON s.`id`=t.`id`
 WHERE (p.instance) IS NULL OR (p.instance) NOT IN ('homolog','suprimaxxi') OR ((p.instance)='suprimaxxi' AND (t.`id` IS NULL OR NOT ((BINARY s.`id` <=> BINARY t.`id`)
        AND (BINARY s.`idempotency_key` <=> BINARY t.`idempotency_key`)
        AND (BINARY s.`client_id` <=> BINARY t.`client_id`)
        AND (BINARY s.`event_type` <=> BINARY t.`event_type`)
        AND (BINARY s.`provider_message_id` <=> BINARY t.`provider_message_id`)
        AND (BINARY s.`payload_hash` <=> BINARY t.`payload_hash`)
        AND (BINARY s.`payload` <=> BINARY t.`payload`)
        AND (BINARY s.`status` <=> BINARY t.`status`)
        AND (BINARY s.`retry_count` <=> BINARY t.`retry_count`)
        AND (BINARY s.`max_retries` <=> BINARY t.`max_retries`)
        AND (BINARY s.`error` <=> BINARY t.`error`)
        AND (BINARY s.`message_id` <=> BINARY t.`message_id`)
        AND (BINARY s.`locked_until` <=> BINARY t.`locked_until`)
        AND (BINARY s.`locked_by` <=> BINARY t.`locked_by`)
        AND (BINARY s.`processing_started_at` <=> BINARY t.`processing_started_at`)
        AND (BINARY s.`next_attempt_at` <=> BINARY t.`next_attempt_at`)
        AND (BINARY s.`completed_at` <=> BINARY t.`completed_at`)
        AND (BINARY s.`created_at` <=> BINARY t.`created_at`)
        AND (BINARY s.`updated_at` <=> BINARY t.`updated_at`)))) OR s.status<>'COMPLETED';
