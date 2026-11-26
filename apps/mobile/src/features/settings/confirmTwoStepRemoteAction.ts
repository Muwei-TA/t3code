import * as Dialog from "../../components/ui/Dialog";

export function confirmTwoStepRemoteAction(input: {
  readonly reviewTitle: string;
  readonly reviewMessage: string;
  readonly reviewConfirmText: string;
  readonly finalTitle: string;
  readonly finalMessage: string;
  readonly finalConfirmText: string;
  readonly destructive?: boolean;
  readonly onConfirmed: () => void;
}) {
  Dialog.confirm({
    title: input.reviewTitle,
    message: input.reviewMessage,
    confirmText: input.reviewConfirmText,
    onConfirm: () => {
      Dialog.confirm({
        title: input.finalTitle,
        message: input.finalMessage,
        confirmText: input.finalConfirmText,
        ...(input.destructive ? { destructive: true } : {}),
        onConfirm: input.onConfirmed,
      });
    },
  });
}
