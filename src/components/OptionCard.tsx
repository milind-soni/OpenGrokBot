import { useMemo, useState } from "react";
import { Check, X } from "lucide-react";
import { useStore, type Message } from "@/state/store";
import { answeredLabels, joinAnswers } from "@/lib/card-answer";
import { cn } from "@/lib/cn";

const LETTERS = ["A", "B", "C", "D", "E", "F"];

export function OptionCard({
  botId,
  message,
  /** set when the card is in a room: the answer belongs to the room's thread */
  groupId,
}: {
  botId: string;
  message: Message;
  groupId?: string;
}) {
  const { dispatch } = useStore();
  const [custom, setCustom] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const card = message.card;
  const chosen = useMemo(() => answeredLabels(card?.answered), [card?.answered]);
  if (!card || card.dismissed) return null;

  const multi = card.multiSelect === true;
  const answer = (text: string) => {
    if (!text.trim()) return;
    dispatch({ type: "answerCard", botId, messageId: message.id, answer: text.trim(), groupId });
  };
  const send = () => answer(joinAnswers(card.options, picked));
  const toggle = (option: string) =>
    setPicked((current) =>
      current.includes(option) ? current.filter((item) => item !== option) : [...current, option],
    );

  return (
    <div className="w-full max-w-[840px] rounded-2xl border border-hairline/50 bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[16px] font-semibold text-ink">{card.title}</div>
          <div className="mt-0.5 text-[14px] text-ink-secondary">
            {card.subtitle}
          </div>
        </div>
        <button
          onClick={() =>
            dispatch({ type: "dismissCard", botId, messageId: message.id, groupId })
          }
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {multi && !card.answered && (
        <div className="mt-2 text-[12.5px] text-ink-secondary">Pick as many as apply, then send.</div>
      )}

      <div className="mt-3 overflow-hidden rounded-lg border border-hairline/40">
        {card.options.map((opt, i) => {
          const selected = card.answered ? chosen.has(opt) : picked.includes(opt);
          const hint = card.optionHints?.[opt];
          return (
            <button
              key={opt}
              disabled={!!card.answered}
              onClick={() => (multi ? toggle(opt) : answer(opt))}
              className={cn(
                "flex w-full items-start gap-3 px-3 py-3 text-left text-[15px] text-ink",
                i > 0 && "border-t border-hairline/40",
                selected ? "bg-raised" : "hover:bg-raised/60 disabled:hover:bg-transparent",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md text-[12px] font-medium",
                  selected ? "bg-accent text-white" : "bg-raised text-ink-secondary",
                )}
              >
                {selected ? <Check size={13} /> : LETTERS[i]}
              </span>
              <span className="min-w-0">
                {opt}
                {/* why you would pick this one — the asking tool sends an
                    explanation per option, and dropping it left four
                    near-identical labels with nothing to choose between */}
                {hint && <span className="mt-0.5 block text-[13px] leading-snug text-ink-secondary">{hint}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {multi && !card.answered && (
        <button
          onClick={send}
          disabled={!picked.length}
          className="mt-3 rounded-full bg-accent px-3.5 py-1.5 text-[13.5px] font-medium text-white transition-colors hover:brightness-110 disabled:opacity-40"
        >
          Send
        </button>
      )}

      {/* a permission ask has no free-text answer — the broker only accepts
          allow/deny, so typing here used to fail silently */}
      {!card.answered && !card.tool && (
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && answer(custom)}
          placeholder="Type your own answer"
          className="mt-3 w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline"
        />
      )}
    </div>
  );
}
