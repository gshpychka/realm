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
  type Asking,
  addressPrompt,
  asking,
  type ConsultModel,
  digestBudget,
  firstPrompt,
  modelAt,
  REVIEW,
  replyQuestion,
} from "./consult.ts";
import { Consults, type LiveConsult, stoppable, working } from "./consults.ts";

export interface UseConsultOptions {
  pi: PiControls | undefined;
  session: SessionController;
  editor: RefObject<EditorHandle | null>;
  /** The App's list: a spec opens one, null closes it. */
  pick: Dispatch<SetStateAction<PickerSpec | null>>;
  ask(question: Question): Promise<string | null>;
  /** Shows a passing hint. */
  flash(text: string): () => void;
  /**
   * Whether what would go to the agent has to wait, as while a move through the session's tree
   * summarizes the branch it leaves; it says so itself.
   */
  held(): boolean;
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
  /** Takes the card `id` away, stopping its consultant when it is at work, and says so. */
  cancel(id: string): void;
  /** What the card `consult` says, as text: the reply so far, and why it failed when it did. */
  textOf(consult: LiveConsult): Promise<string>;
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
 * replacements; a consultant's Pi runs while its card shows. Null for Dura.
 */
export function useConsult({
  pi,
  session,
  editor,
  pick,
  ask,
  flash,
  held,
}: UseConsultOptions): Consult | null {
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
  const begin = async (models: readonly ConsultModel[], question: Asking) => {
    const { digest, omitted, at } = await conversation.bridge({
      kind: "consult-context",
      budget: digestBudget(models),
    });
    if (!digest) return notify("info", NOTHING_YET);
    const prompt = firstPrompt({ digest, omitted, question: question.question, agent: agent() });
    consults.start(models, question, prompt, at, conversation.workspace().cwd);
  };

  /** The list of models to ask `question`; `chosen` runs once they are chosen. */
  const choose = (question: Asking, chosen?: () => void) => {
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
        // A declared model Pi does not list is offered all the same: asked, Pi says why it cannot
        // answer. One that names no provider cannot be asked at all, which its row says.
        const unlisted = declared
          .filter((each) => !listed.some((item) => item.value === each))
          .map(
            (each): PickItem => ({
              label: each,
              detail: modelAt(each) ? "declared · Pi does not list it" : "declared · not provider/id",
              value: each,
            }),
          );
        const marked = declared.length
          ? declared.filter((each) => modelAt(each))
          : consults.chosen.filter((each) => listed.some((item) => item.value === each));
        // The marked models lead the list, the conversation's own after them, so all are in view as it opens.
        const rank = (item: PickItem) => {
          const at = marked.indexOf(item.value);
          return at !== -1 ? at : item.value === current ? marked.length : marked.length + 1;
        };
        const items = [...unlisted, ...listed].sort((a, b) => rank(a) - rank(b));
        pick({
          title: "second opinion · tab marks several",
          items,
          multiple: true,
          marked,
          onPick: (_, values) => {
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
            const unaskable = values.filter((value) => !modelAt(value));
            if (unaskable.length)
              notify("warning", `/consult: name ${unaskable.join(", ")} as provider/id to ask it.`);
            // Nothing asked leaves the draft as it was.
            if (!picked.length) return;
            chosen?.();
            consults.chosen = values;
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
        const { stopped, cleared } = consults.cancelAll();
        // An answer already recorded joins the conversation all the same, so nothing is said of it.
        const said = [
          stopped && `cancelled ${counted(stopped, "second opinion")}`,
          cleared && `cleared ${stopped ? cleared : counted(cleared, "second opinion")} that failed`,
        ].filter(Boolean);
        if (said.length) flash(said.join(" · "));
        else notify("info", NOTHING_TO_CANCEL);
        return;
      }
      choose(args ? asking(args) : REVIEW);
    },
    fromDraft() {
      if (held()) return;
      const draft = editor.current?.text().trim() ?? "";
      choose(draft ? asking(draft) : REVIEW, draft ? () => editor.current?.set("") : undefined);
    },
    weighIn(reply) {
      if (!held()) choose(replyQuestion(reply.text, agent()));
    },
    address(opinion) {
      if (!held()) void latest.current.send(addressPrompt(opinion));
    },
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
        .then(async (text) => {
          const question = text?.trim();
          if (!question) return;
          const about = await conversation.bridge({ kind: "position" });
          if (
            !consults.followUp(
              { ...opinion, session: continued },
              asking(question),
              about,
              conversation.workspace().cwd,
            )
          )
            flash(`${model} is still answering`);
        })
        .catch(failed);
    },
    cancel(id) {
      const card = consults.cancel(id);
      if (!card) return;
      const name = modelName(card.model);
      flash(stoppable(card) ? `cancelled ${name}'s second opinion` : `cleared ${name}'s second opinion`);
    },
    textOf: (consult) => consults.textOf(consult),
  };
}
