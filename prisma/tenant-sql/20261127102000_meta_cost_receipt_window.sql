-- Apply to physical tenant runtime tables only. For Infotec, whose runtime
-- exposes a view, apply the same index to the underlying wpp_hml_waba_webhook_queue.
ALTER TABLE `wpp_runtime_waba_webhook_queue`
  ADD INDEX `waba_webhook_queue_instance_created_at_idx` (`instance`, `created_at`),
  ALGORITHM=INPLACE, LOCK=NONE;
