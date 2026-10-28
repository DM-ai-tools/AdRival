-- A lookup's recreation bridge run (jobs id 'lookup-recreate-<lookup id>') was
-- saved with no client space, so its recreations never showed in the Recreate
-- tab of the lookup's space and space members could not open them. Give every
-- bridge run its lookup's space (the column and the record), and the queue's
-- jobs of those runs too (their space is the run's space when they were added).
update jobs j
   set space_id = l.space_id,
       data     = jsonb_set(j.data, '{spaceId}', to_jsonb(l.space_id))
  from lookup_jobs l
 where j.id = 'lookup-recreate-' || l.id
   and l.space_id is not null
   and j.space_id is distinct from l.space_id;

update recreate_jobs r
   set space_id = l.space_id
  from lookup_jobs l
 where r.run_id = 'lookup-recreate-' || l.id
   and l.space_id is not null
   and r.space_id is distinct from l.space_id;
