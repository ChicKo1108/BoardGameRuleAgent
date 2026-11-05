if (process.argv.includes("--check")) {
  console.info("Worker scaffold loads. Queue and task handlers are not implemented.");
} else {
  console.error("Worker is not operational yet. See docs/03-ingestion-and-release.md.");
  process.exitCode = 1;
}
