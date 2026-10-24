-- 003_provider_calls_idempotency: one provider call per idempotency key.
--
-- settleProviderCall charges a call exactly once per idempotencyKey: a retried
-- settlement returns the first record and changes no balance. The repository
-- checks for the key under an advisory lock; this index is the backstop that
-- makes a second row with the same key impossible.
--
-- The file store enforced the same rule in code, so imported data has no
-- duplicate keys (the importer must keep the first row if it ever finds one).
create unique index provider_calls_idempotency_key_idx
  on provider_calls ((data->>'idempotencyKey'));
