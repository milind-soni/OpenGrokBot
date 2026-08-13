import { packTranscript } from "../server/context.ts";

// Representative long-running support task: an initial objective, 30 settled
// turns with logs/results, then a final constrained request. This is a stable,
// offline benchmark of prompt payload only; it does not pretend to measure a
// provider's tokenizer, latency, or task success rate.
const transcript = [
  { role: "user" as const, text: "Investigate the release failure, keep secrets out of logs, and give me a verified fix." },
  ...Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 === 0 ? ("assistant" as const) : ("user" as const),
    text: `Turn ${index + 1}: ${"diagnostic detail, command output, constraints, and verification evidence ".repeat(70)}`,
  })),
  { role: "user" as const, text: "Now give the minimal verified remediation and preserve the deployment rollback plan." },
];

const { stats } = packTranscript(transcript);
const reduction = ((1 - stats.submittedChars / stats.originalChars) * 100).toFixed(1);

console.log("Context packing benchmark (offline deterministic fixture)");
console.log(`Messages: ${stats.originalMessages} → ${stats.submittedMessages} (${stats.omittedMessages} compacted)`);
console.log(`Characters: ${stats.originalChars} → ${stats.submittedChars} (${reduction}% reduction)`);
console.log(`Estimated input tokens: ${stats.originalEstimatedTokens} → ${stats.submittedEstimatedTokens}`);
console.log("Accuracy note: this benchmark verifies preservation of the original goal and most recent exchange structurally; it does not claim model task-success results.");
