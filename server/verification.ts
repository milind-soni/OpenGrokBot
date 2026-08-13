/** A deliberately narrow completion-evidence summary. Tool completion proves
 * only that the action returned success; it never upgrades an agent claim to
 * task success without an independent verifier. */
export interface TurnEvidence { started: number; succeeded: number; failed: number; }

export function emptyEvidence(): TurnEvidence { return { started: 0, succeeded: 0, failed: 0 }; }

export function completionEvidence(evidence: TurnEvidence, turnOk: boolean): { name: string; ok: boolean } | null {
  if (!turnOk) return evidence.failed ? { name: `Evidence: ${evidence.failed} tool action${evidence.failed === 1 ? "" : "s"} failed`, ok: false } : null;
  if (evidence.failed) return { name: `Evidence: ${evidence.succeeded} tool action${evidence.succeeded === 1 ? "" : "s"} succeeded, ${evidence.failed} failed`, ok: false };
  if (evidence.succeeded) return { name: `Evidence: ${evidence.succeeded} tool action${evidence.succeeded === 1 ? "" : "s"} succeeded; task result is agent-reported`, ok: true };
  return null;
}
