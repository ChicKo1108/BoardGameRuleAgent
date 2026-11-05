import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { adminSchemas } from "@boardgame/contracts";
const rect = z
  .tuple([
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
    z.number().min(0).max(1),
  ])
  .refine((r) => r[0] < r[2] && r[1] < r[3], "Invalid region");
export const parserConfigSchema = z
  .strictObject({
    engine: z.literal("pdfplumber").default("pdfplumber"),
    pageLabels: z
      .array(
        z.strictObject({
          pageIndex: z.number().int().min(0).max(99),
          label: z.string().trim().min(1).max(40),
        }),
      )
      .max(100)
      .default([]),
    pageRegions: z
      .array(
        z.strictObject({
          pageIndex: z.number().int().min(0).max(99),
          regions: z.array(rect).min(1).max(8),
        }),
      )
      .max(100)
      .default([]),
  })
  .superRefine((config, ctx) => {
    if (
      new Set(config.pageLabels.map((p) => p.pageIndex)).size !==
      config.pageLabels.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate page label" });
    const seen = new Set<number>();
    for (const page of config.pageRegions) {
      if (seen.has(page.pageIndex))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate page configuration",
        });
      seen.add(page.pageIndex);
      for (let i = 0; i < page.regions.length; i++)
        for (let j = i + 1; j < page.regions.length; j++) {
          const a = page.regions[i],
            b = page.regions[j];
          if (
            Math.min(a[2], b[2]) > Math.max(a[0], b[0]) &&
            Math.min(a[3], b[3]) > Math.max(a[1], b[1])
          )
            ctx.addIssue({ code: "custom", message: "Regions overlap" });
        }
    }
  });
export type ParserConfig = z.infer<typeof parserConfigSchema>;
export const parserResultSchema = z.object({
  pipelineVersion: z.enum(["pdfplumber-regions-v1", "pdfplumber-regions-v2"]),
  parserVersion: z.string(),
  pages: z
    .array(
      z.object({
        pageIndex: z.number().int().min(0),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    )
    .min(1)
    .max(100),
  blocks: z.array(adminSchemas.sourceBlock).min(1).max(2000),
  warnings: z
    .array(
      z.object({
        code: z.enum([
          "READING_ORDER_REVIEW",
          "FIGURES_REQUIRE_REVIEW",
          "LOW_TEXT_PAGE",
          "UNASSIGNED_TEXT",
        ]),
        pageIndex: z.number().int().min(0),
      }),
    )
    .max(400),
});
export type ParserResult = z.infer<typeof parserResultSchema>;
export class ParseError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
  }
}
export interface PdfParser {
  parse(
    bytes: Buffer,
    config: ParserConfig,
    signal?: AbortSignal,
  ): Promise<ParserResult>;
}
export class PythonPdfParser implements PdfParser {
  constructor(
    private readonly python: string,
    private readonly script: string,
    private readonly timeoutMs = 120000,
  ) {}
  async parse(
    bytes: Buffer,
    config: ParserConfig,
    signal?: AbortSignal,
  ): Promise<ParserResult> {
    const dir = await mkdtemp(join(tmpdir(), "boardgame-parse-"));
    try {
      const input = join(dir, "source.pdf");
      await writeFile(input, bytes, { mode: 0o600 });
      const raw = await new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new ParseError("PARSE_ABORTED", true));
          return;
        }
        const child = spawn(this.python, [this.script, input], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        let output = "";
        let count = 0;
        let failure: ParseError | undefined;
        const stop = (error: ParseError) => {
          failure ??= error;
          child.kill("SIGKILL");
        };
        const abort = () => stop(new ParseError("PARSE_ABORTED", true));
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () => stop(new ParseError("PARSE_TIMEOUT", true)),
          this.timeoutMs,
        );
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          count += Buffer.byteLength(chunk);
          if (count > 16 * 1024 * 1024)
            stop(new ParseError("PARSE_OUTPUT_TOO_LARGE"));
          else output += chunk;
        });
        // Do not include raw stderr or filesystem paths in persisted job errors.
        child.stderr.resume();
        child.on("error", () => {
          failure = new ParseError("PARSER_UNAVAILABLE", true);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (failure) return reject(failure);
          if (code !== 0) {
            try {
              const err = JSON.parse(output);
              if (typeof err.error === "string" && /^[A-Z_]+$/.test(err.error))
                return reject(new ParseError(err.error));
            } catch {}
            return reject(new ParseError("PARSE_FAILED"));
          }
          resolve(output);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(config));
      });
      try {
        const result = parserResultSchema.parse(JSON.parse(raw));
        const ordinals = new Set<number>();
        const pages = new Set(result.pages.map((p) => p.pageIndex));
        for (const block of result.blocks) {
          if (ordinals.has(block.ordinal) || !pages.has(block.pdfPageIndex))
            throw new Error("Bad provenance");
          ordinals.add(block.ordinal);
        }
        if (result.warnings.some((w) => !pages.has(w.pageIndex)))
          throw new Error("Bad warning provenance");
        return result;
      } catch {
        throw new ParseError("INVALID_PARSER_RESULT");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
