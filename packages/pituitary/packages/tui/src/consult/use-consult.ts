import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditorHandle } from "../components/editor.tsx";
import type { PickerSpec, PickItem } from "../components/picker.tsx";
import { modelName, modelSource } from "../model-names.ts";
import type { PiControls, RpcData } from "../pi.ts";
import { type Opinion, opinionModel } from "../pi-bridge.ts";
import { counted } from "../plural.ts";
import { providerMark } from "../provider.ts";
import type { Reply } from "../transcript.ts";
import type { Question } from "../use-ask.ts";
import type { SessionController } from "../use-session.ts";
import {
  addressPrompt,
  type ConsultModel,
  DEFAULT_QUESTION,
  digestBudget,
  firstPrompt,
  modelAt,
  replyQuestion,
} from "./consult.ts";
import { Consults, type LiveConsult, working } from "./consults.ts";

export interface UseConsultOptions {
  pi: PiControls | undefined;
  session: SessionController;
  editor: RefObject<EditorHandle | null>;
  /** The App's list: a spec opens one, null closes it. */
  pick: Dispatch<SetStateAction<PickerSpec | null>>;
  ask(question: Question): Promise<string | null>;
  /** Shows a passing hint. */
  flash(text: string): () => void;
}

/** Regular Pi's second opinions, as the App reaches them. */
export interface Consult {
  /** The consultations a card shows at the conversation's end: those at work, and those that failed. */
  live: readonly LiveConsult[];
  /** The models still at work, by name, for the working line. */
  working: readonly string[];
  /** Runs `/consult [question|cancel]`. */
  run(args: string): void;
  /** Asks the draft's text, or the default question when it is empty; the draft empties once the models are chosen. */
  fromDraft(): void;
  /** Asks about one of the agent's replies. */
  weighIn(reply: Reply): void;
  /** Asks the agent to weigh `opinion`, steering a run under way. */
  address(opinion: Opinion): void;
  /** Asks the consultant that gave `opinion` a follow-up the operator writes; its answer records as a new opinion. */
  reply(opinion: Opinion): void;
  /** Takes the card `id` away, stopping its consultant when it is at work. */
  cancel(id: string): void;
}

const NONE: readonly LiveConsult[] = [];
const nothing = () => NONE;
const unsubscribed = () => () => {};

/** What /consult cancel answers when there is nothing to cancel. */
const NOTHING_TO_CANCEL = "No second opinion is under way.";
/** What a consultation answers before the conversation holds anything to consult on. */
const NOTHING_YET = "There is nothing to consult on yet: ask something first.";

type PiModel = RpcData<"get_available_models">["models"][number];

/**
 * Second opinions from other models on regular Pi's conversation, each answered by a Pi of its
 * own with read-only tools, recorded in the conversation as it settles. They outlast session
 * replacements; their Pi processes end with the frontend. Null for Dura.
 */
export function useConsult({ pi, session, editor, pick, ask, flash }: UseConsultOptions): Consult | null {
  const [consults] = useState(() =>
    pi ? new Consults({ launch: pi.consult, main: pi.conversation }) : null,
  );
  useEffect(() => () => consults?.dispose(), [consults]);
  const live = useSyncExternalStore(consults?.subscribe ?? unsubscribed, consults?.snapshot ?? nothing);
  // Continuations run after the list and the dialog; they read the session as it is then.
  const latest = useRef(session);
  latest.current = session;
  if (!pi || !consults) return null;
  const { conversation } = pi;
  const notify: SessionController["notify"] = (level, text, file) => latest.current.notify(level, text, file);
  const failed = (error: unknown) =>
    notify("error", `/consult: ${error instanceof Error ? error.message : String(error)}`);
  /** The agent the conversation is with, by its model's name. */
  const agent = () => {
    const model = latest.current.state?.model;
    return model ? modelName(model) : "pi";
  };

  /** Asks `models` `question` about the conversation as it is. */
  const begin = async (models: readonly ConsultModel[], question: string) => {
    const { digest, omitted } = await conversation.bridge({
      kind: "consult-context",
      budget: digestBudget(models),
    });
    const about = latest.current.state?.sessionFile;
    if (!digest || !about) return notify("info", NOTHING_YET);
    const prompt = firstPrompt({ digest, omitted, question, agent: agent() });
    consults.start(models, question, prompt, about, conversation.workspace().cwd);
  };

  /** The list of models to ask `question`; `chosen` runs once they are chosen. */
  const choose = (question: string, chosen?: () => void) => {
    const { view, state } = latest.current;
    if (!view.entries.some((entry) => entry.kind === "user")) return notify("info", NOTHING_YET);
    void conversation
      .rpc({ type: "get_available_models" })
      .then(({ models }) => {
        const address = (model: Pick<PiModel, "provider" | "id">) => `${model.provider}/${model.id}`;
        const { declared } = pi.consult;
        const current = state?.model && address(state.model);
        const listed: PickItem[] = models.map((model) => ({
          label: modelName(model),
          detail: address(model) === current ? "this conversation's model" : modelSource(model),
          icon: providerMark(model.provider),
          value: address(model),
        }));
        // A declared model Pi does not list is offered all the same: asked, Pi says why it cannot answer.
        const unlisted = declared
          .filter((each) => !listed.some((item) => item.value === each))
          .map((each): PickItem => ({ label: each, detail: "declared · Pi does not list it", value: each }));
        const marked = declared.length
          ? declared
          : consults.chosen.filter((each) => listed.some((item) => item.value === each));
        // The marked models lead the list, the conversation's own after them, so all are in view as it opens.
        const rank = (item: PickItem) => {
          const at = marked.indexOf(item.value);
          return at !== -1 ? at : item.value === current ? marked.length : marked.length + 1;
        };
        const items = [...unlisted, ...listed].sort((a, b) => rank(a) - rank(b));
        pick({
          title: "second opinion · space marks several",
          items,
          multiple: true,
          marked,
          onPick: (_, values) => {
            chosen?.();
            consults.chosen = values;
            const picked = values.flatMap((value): ConsultModel[] => {
              const model = models.find((each) => address(each) === value);
              if (!model) {
                // Named by its address, which is all there is to tell it by.
                const at = modelAt(value);
                return at ? [{ ...at, name: value }] : [];
              }
              return [
                {
                  provider: model.provider,
                  id: model.id,
                  ...(model.name ? { name: model.name } : {}),
                  contextWindow: model.contextWindow,
                },
              ];
            });
            void begin(picked, question).catch(failed);
          },
        });
      })
      .catch(failed);
  };

  return {
    live,
    working: live.filter(working).map((consult) => modelName(consult.model)),
    run(args) {
      if (args === "cancel") {
        const cancelled = consults.cancelAll();
        if (cancelled === 0) notify("info", NOTHING_TO_CANCEL);
        else flash(`cancelled ${counted(cancelled, "second opinion")}`);
        return;
      }
      choose(args || DEFAULT_QUESTION);
    },
    fromDraft() {
      const draft = editor.current?.text().trim() ?? "";
      choose(draft || DEFAULT_QUESTION, draft ? () => editor.current?.set("") : undefined);
    },
    weighIn: (reply) => choose(replyQuestion(reply.text, agent())),
    address: (opinion) => void latest.current.send(addressPrompt(opinion)),
    reply(opinion) {
      const { session: continued } = opinion;
      if (!continued) return notify("warning", "That opinion has no session of its own to continue.");
      const model = opinionModel(opinion);
      void ask({
        method: "input",
        title: `Reply to ${model} · the answer records as a new opinion`,
        placeholder: "your follow-up",
        submits: "asks it",
      })
        .then((text) => {
          const question = text?.trim();
          const about = latest.current.state?.sessionFile;
          if (!question || !about) return;
          if (
            !consults.followUp(
              { ...opinion, session: continued },
              question,
              about,
              conversation.workspace().cwd,
            )
          )
            flash(`${model} is still answering`);
        })
        .catch(failed);
    },
    cancel: (id) => consults.cancel(id),
  };
}
