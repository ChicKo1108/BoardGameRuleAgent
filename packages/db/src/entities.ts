import { EntitySchema, type EntitySchemaColumnOptions } from "typeorm";

export interface Game { id: string; slug: string; name: string; createdAt: Date; }
export interface Ruleset { id: string; gameId: string; name: string; language: string; scope: string; createdAt: Date; }
export interface SourceDocument { id: string; rulesetId: string; title: string; sourceType: string; objectKey: string; sha256: string; createdAt: Date; }
export type RevisionStatus = "uploaded" | "parsing" | "awaiting_review" | "approved";
export interface DocumentRevision { id: string; documentId: string; number: number; status: RevisionStatus; parserConfig: Record<string, unknown>; createdAt: Date; }
export interface SourceBlock { id: string; revisionId: string; ordinal: number; kind: string; rawText: string; pdfPageIndex: number; printedPageLabel: string | null; bbox: number[] | null; }
export interface RuleUnit { id: string; revisionId: string; kind: string; reviewedText: string; sectionPath: string[]; applicability: string[]; explanation: string | null; reviewStatus: "pending" | "approved" | "rejected"; }
const id: EntitySchemaColumnOptions = { type: "uuid", primary: true, generated: "uuid" };
const createdAt: EntitySchemaColumnOptions = { name: "created_at", type: "timestamptz", createDate: true };
export const GameEntity = new EntitySchema<Game>({ name: "Game", tableName: "games", columns: { id, slug: { type: String }, name: { type: String }, createdAt } });
export const RulesetEntity = new EntitySchema<Ruleset>({ name: "Ruleset", tableName: "rulesets", columns: { id, gameId: { name: "game_id", type: "uuid" }, name: { type: String }, language: { type: String }, scope: { type: String }, createdAt } });
export const SourceDocumentEntity = new EntitySchema<SourceDocument>({ name: "SourceDocument", tableName: "source_documents", columns: { id, rulesetId: { name: "ruleset_id", type: "uuid" }, title: { type: String }, sourceType: { name: "source_type", type: String }, objectKey: { name: "object_key", type: String }, sha256: { type: String }, createdAt } });
export const DocumentRevisionEntity = new EntitySchema<DocumentRevision>({ name: "DocumentRevision", tableName: "document_revisions", columns: { id, documentId: { name: "document_id", type: "uuid" }, number: { type: Number }, status: { type: String }, parserConfig: { name: "parser_config", type: "jsonb", default: {} }, createdAt } });
export const SourceBlockEntity = new EntitySchema<SourceBlock>({ name: "SourceBlock", tableName: "source_blocks", columns: { id, revisionId: { name: "revision_id", type: "uuid" }, ordinal: { type: Number }, kind: { type: String }, rawText: { name: "raw_text", type: "text" }, pdfPageIndex: { name: "pdf_page_index", type: Number }, printedPageLabel: { name: "printed_page_label", type: String, nullable: true }, bbox: { type: "jsonb", nullable: true } } });
export const RuleUnitEntity = new EntitySchema<RuleUnit>({ name: "RuleUnit", tableName: "rule_units", columns: { id, revisionId: { name: "revision_id", type: "uuid" }, kind: { type: String }, reviewedText: { name: "reviewed_text", type: "text" }, sectionPath: { name: "section_path", type: "jsonb", default: [] }, applicability: { type: "jsonb", default: [] }, explanation: { type: "text", nullable: true }, reviewStatus: { name: "review_status", type: String } } });
export const entities = [GameEntity, RulesetEntity, SourceDocumentEntity, DocumentRevisionEntity, SourceBlockEntity, RuleUnitEntity];
