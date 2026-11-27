-- Bound the receipt scan to the active tenant and acquisition interval.
ALTER TABLE `waba_webhook_queue`
  ADD INDEX `waba_webhook_queue_instance_created_at_idx` (`instance`, `created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
