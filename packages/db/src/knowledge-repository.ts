import { type DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import { DocumentRevisionEntity, GameEntity, RulesetEntity, SourceDocumentEntity, SourceBlockEntity, RuleUnitEntity,
  type SourceBlock, type RuleUnit } from "./entities.js";

/** Called only after application-layer authentication and input validation. */
export class KnowledgeRepository {
  constructor(private readonly db: DataSource) {}
  async createGame(input: { slug: string; name: string }) {
    return this.db.getRepository(GameEntity).save({ id: randomUUID(), ...input });
  }
  async createRuleset(input: { gameId: string; name: string; language: string; scope: string }) {
    return this.db.getRepository(RulesetEntity).save({ id: randomUUID(), ...input });
  }
  async createDocument(input: { rulesetId: string; title: string; sourceType: string; objectKey: string; sha256: string }) {
    return this.db.getRepository(SourceDocumentEntity).save({ id: randomUUID(), ...input });
  }
  async createRevision(documentId: string, parserConfig: Record<string, unknown> = {}) {
    return this.db.transaction(async tx => {
      const document = await tx.getRepository(SourceDocumentEntity).findOne({ where: { id: documentId }, lock: { mode: "pessimistic_write" } });
      if (!document) throw new Error("DOCUMENT_NOT_FOUND");
      const latest = await tx.getRepository(DocumentRevisionEntity).findOne({ where: { documentId }, order: { number: "DESC" } });
      return tx.getRepository(DocumentRevisionEntity).save({ id: randomUUID(), documentId, number: (latest?.number ?? 0) + 1, status: "uploaded", parserConfig });
    });
  }
  async saveParsedBlocks(revisionId: string, blocks: Array<Omit<SourceBlock, "id" | "revisionId">>) {
    if (!blocks.length) throw new Error("EMPTY_PARSE_RESULT");
    return this.db.transaction(async tx => {
      const revision = await tx.getRepository(DocumentRevisionEntity).findOne({ where: { id: revisionId }, lock: { mode: "pessimistic_write" } });
      if (!revision || !["uploaded", "parsing"].includes(revision.status)) throw new Error("REVISION_NOT_PARSEABLE");
      const saved = await tx.getRepository(SourceBlockEntity).save(blocks.map(b => ({ ...b, id: randomUUID(), revisionId })));
      await tx.getRepository(DocumentRevisionEntity).update(revisionId, { status: "awaiting_review" });
      return saved;
    });
  }
  async addRule(input: Omit<RuleUnit, "id">, sourceBlockIds: string[]) {
    if (!sourceBlockIds.length) throw new Error("RULE_REQUIRES_SOURCE");
    return this.db.transaction(async tx => {
      const revision = await tx.getRepository(DocumentRevisionEntity).findOne({ where: { id: input.revisionId }, lock: { mode: "pessimistic_write" } });
      if (!revision || revision.status !== "awaiting_review") throw new Error("REVISION_NOT_EDITABLE");
      const rule = await tx.getRepository(RuleUnitEntity).save({ ...input, id: randomUUID() });
      for (const blockId of new Set(sourceBlockIds)) {
        await tx.query("INSERT INTO rule_sources(revision_id,rule_unit_id,block_id) VALUES ($1,$2,$3)", [input.revisionId, rule.id, blockId]);
      }
      return rule;
    });
  }
  async approveRevision(revisionId: string) {
    return this.db.transaction(async tx => {
      const revision = await tx.getRepository(DocumentRevisionEntity).findOne({ where: { id: revisionId }, lock: { mode: "pessimistic_write" } });
      if (!revision || revision.status !== "awaiting_review") throw new Error("REVISION_NOT_REVIEWABLE");
      await tx.getRepository(DocumentRevisionEntity).update(revisionId, { status: "approved" });
      return { ...revision, status: "approved" as const };
    });
  }
}
