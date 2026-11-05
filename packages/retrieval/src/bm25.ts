// bm25-v1: canonical lexical tokens; k1=1.2, b=0.75, natural-log positive IDF.
// Statistics are local to one immutable index, never the whole database.
const ranking = `SELECT d.chunk_id AS "chunkId",d.rule_id AS "ruleId",
 sum(ln(1.0+(s.document_count-t.document_frequency+0.5)/(t.document_frequency+0.5))*
 ((d.term_counts->>q.term)::float8*2.2)/
 ((d.term_counts->>q.term)::float8+1.2*(0.25+0.75*d.token_count/(s.total_tokens::float8/s.document_count))) ORDER BY q.term)::float8 AS score
 FROM docs d CROSS JOIN corpus s CROSS JOIN query_terms q
 JOIN terms t ON t.term=q.term WHERE d.term_counts ? q.term
 GROUP BY d.chunk_id,d.rule_id ORDER BY score DESC,d.chunk_id`;
export const persistedBm25Sql = `WITH docs AS (
 SELECT d.chunk_id,c.rule_unit_id AS rule_id,d.token_count,d.term_counts FROM bm25_documents d
 JOIN retrieval_chunks c ON c.id=d.chunk_id AND c.build_id=d.build_id AND c.release_id=d.release_id WHERE d.build_id=$1 AND d.release_id=$2),
 corpus AS(SELECT document_count,total_tokens FROM bm25_corpora WHERE build_id=$1 AND release_id=$2),
 terms AS(SELECT term,document_frequency FROM bm25_terms WHERE build_id=$1 AND release_id=$2),
 query_terms AS(SELECT DISTINCT unnest($3::text[]) AS term)
 ${ranking} LIMIT $4`;
export const draftBm25Sql = `WITH input AS(
 SELECT x.chunk_id::uuid AS chunk_id,x.rule_id::uuid AS rule_id,string_to_array(x.lexical_text,' ') AS tokens
 FROM jsonb_to_recordset($1::jsonb) AS x(chunk_id text,rule_id text,lexical_text text)),
 docs AS(SELECT i.chunk_id,i.rule_id,cardinality(i.tokens) AS token_count,
 (SELECT jsonb_object_agg(term,n) FROM(SELECT term,count(*) AS n FROM unnest(i.tokens) AS term GROUP BY term) f) AS term_counts FROM input i),
 corpus AS(SELECT count(*)::int AS document_count,sum(token_count)::bigint AS total_tokens FROM docs),
 terms AS(SELECT term,count(*)::int AS document_frequency FROM docs CROSS JOIN LATERAL jsonb_object_keys(term_counts) AS term GROUP BY term),
 query_terms AS(SELECT DISTINCT unnest($2::text[]) AS term)
 ${ranking} LIMIT $3`;
