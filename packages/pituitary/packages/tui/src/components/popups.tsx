import { Dialog, type DialogRequest, type DialogResponse } from "./dialog.tsx";
import { Picker, type PickerSpec } from "./picker.tsx";
import { type Suggestion, Suggestions } from "./suggestions.tsx";

export interface PopupsProps {
  /** Operator dialogs, the one to answer first. */
  dialogs: readonly DialogRequest[];
  picker: PickerSpec | null;
  /** What the draft could complete to, with the one chosen, while the draft has the keyboard. */
  completion: { items: Suggestion[]; index: number } | null;
  /** Rows the screen leaves a popup above the editor. */
  rows: number;
  onAnswer(id: string, response: DialogResponse): void;
  onClosePicker(): void;
}

/**
 * Dialogs and pickers take the keyboard above the editor; suggestions appear while editing.
 */
export function Popups({ dialogs, picker, completion, rows, onAnswer, onClosePicker }: PopupsProps) {
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
  const compact = rows < 8;
  return (
    <>
      {picker ? (
        <Picker
          key={picker.title}
          spec={picker}
          compact={compact}
          rows={rows - (compact ? 3 : 5)}
          onClose={onClosePicker}
        />
      ) : null}
      {completion && !picker ? (
        <Suggestions items={completion.items} index={completion.index} rows={rows - 1} />
      ) : null}
    </>
  );
}
