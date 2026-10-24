-- 002_indexes: indexes for queries added after 001.
--
-- deleteHistoryRun frees a deleted run's page ids from seen_page_ids unless
-- another competitor still has that pageId; that check looks competitors up
-- by data->>'pageId'.
create index competitors_page_id_idx on competitors ((data->>'pageId'));

-- No index for the lookup_jobs id-prefix scan (`search-offers:<runId>…` in
-- runs.ts): it runs only on stop/delete of a search, the table is small, and
-- the `left(id, length($1)) = $1` form cannot use a btree index anyway.
