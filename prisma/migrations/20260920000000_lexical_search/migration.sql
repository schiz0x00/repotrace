-- Lexical search support: full-text indexes over chunk content and symbol
-- names. `simple` config (no stemming/stopwords) suits source code and
-- identifiers better than the English dictionary config.

ALTER TABLE "chunk" ADD COLUMN "content_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "content")) STORED;
CREATE INDEX "chunk_content_tsv_idx" ON "chunk" USING GIN ("content_tsv");

ALTER TABLE "symbol" ADD COLUMN "name_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', "name")) STORED;
CREATE INDEX "symbol_name_tsv_idx" ON "symbol" USING GIN ("name_tsv");

-- Partial index backing prefix search on qualified symbol names.
CREATE INDEX "symbol_qualified_name_prefix_idx" ON "symbol" ("qualifiedName" text_pattern_ops);