import type { CustomView, DialogRequest, RpcExtensionUIResponse } from "@pituitary/rpc";
import { Checklist, type ChecklistSpec } from "./checklist.tsx";
import { CustomPanel } from "./custom-panel.tsx";
import { Dialog } from "./dialog.tsx";
import { Picker, type PickerSpec } from "./picker.tsx";
import { type Suggestion, Suggestions } from "./suggestions.tsx";

export interface PopupsProps {
  /** Extension dialogs waiting on the operator, the one to answer first. */
  dialogs: readonly DialogRequest[];
  /** The extension component on top, while one is open. */
  custom: CustomView | undefined;
  picker: PickerSpec | null;
  checklist: ChecklistSpec | null;
  /** What the draft could complete to, with the one chosen, while the draft has the keyboard. */
  completion: { items: Suggestion[]; index: number } | null;
  /** Rows the screen leaves a popup above the editor. */
  rows: number;
  onAnswer(id: string, response: RpcExtensionUIResponse): void;
  onClosePicker(): void;
  onCloseChecklist(): void;
}

/**
 * What opens above the editor and holds the keyboard: an extension's dialog before anything,
 * then its own component, then a picker or checklist; the completion list shows alone.
 */
export function Popups({
  dialogs,
  custom,
  picker,
  checklist,
  completion,
  rows,
  onAnswer,
  onClosePicker,
  onCloseChecklist,
}: PopupsProps) {
  const [dialog] = dialogs;
  if (dialog) {
    return (
      <Dialog
        key={dialog.id}
        dialog={dialog}
        behind={dialogs.length - 1}
        rows={rows - 4}
        onAnswer={(response) => onAnswer(dialog.id, response)}
      />
    );
  }
  if (custom) return <CustomPanel view={custom} rows={rows - 2} />;
  return (
    <>
      {picker ? <Picker key={picker.title} spec={picker} rows={rows - 5} onClose={onClosePicker} /> : null}
      {checklist ? (
        <Checklist key={checklist.title} spec={checklist} rows={rows - 6} onClose={onCloseChecklist} />
      ) : null}
      {completion && !picker && !checklist ? (
        <Suggestions items={completion.items} index={completion.index} rows={rows - 1} />
      ) : null}
    </>
  );
}
