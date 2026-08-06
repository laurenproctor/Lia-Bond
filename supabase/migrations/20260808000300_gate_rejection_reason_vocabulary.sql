-- Split gate_rejection_reason so a rejected candidate records which rule
-- rejected it.
--
-- `below_threshold` was returned from three places in evaluateCandidate: no
-- keyword matched, a lone ambiguous term went uncorroborated, and a real score
-- fell under the query's threshold. Only the first was separable, and only by
-- its zero score. The first live GNews poll rejected four articles about a
-- salmonella outbreak at score 0.7 against a 0.35 threshold — all filed as
-- "below relevance threshold", which is false and points a reader at the one
-- dial that cannot fix it.
--
-- Labelling only. The gate admits and rejects exactly what it did before.

-- No backfill is possible, so refuse rather than mislabel. Every existing row
-- would need a guess at which of the three rules produced it, and the score
-- cannot recover that: 0.2 is equally "nothing matched" and "scored too low".
-- The table is empty as this ships. If it is not empty wherever this runs
-- next, that assumption has expired and the rows need a considered backfill,
-- not a silent one.
do $$
begin
  if exists (select 1 from public.news_rejected_candidates) then
    raise exception
      'news_rejected_candidates is not empty; existing rows cannot be classified into the new reasons. Write a backfill before applying this migration.';
  end if;
end
$$;

alter type gate_rejection_reason add value if not exists 'no_keyword_match';
alter type gate_rejection_reason add value if not exists 'ambiguous_uncorroborated';

comment on type gate_rejection_reason is
  'Lia''s own vocabulary. No provider supplies one of these. Each value maps to a different operator action: fix the keywords, tune the threshold, or revisit the ambiguity rule.';
