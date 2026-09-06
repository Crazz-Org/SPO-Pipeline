# Invariants — issue 505

Facts about the existing code this plan relies on staying true while IMPLEMENT works. The store keeps compose fields verbatim (the cap lives in the component), the draft rule is unchanged, the bridge still unlocks the form on a refused send, the gateway still forwards only a boolean from `Post`, and `showToast` keeps its signature and barrel export.

## INV-1
File: src/client/store/mail-store.ts:145-146
>>> QUOTE
  setComposeField: (field, value) =>
    set(field === 'to' ? { composeTo: value } : field === 'subject' ? { composeSubject: value } : { composeBody: value }),
>>> END QUOTE

## INV-2
File: src/client/components/mail/MailPanel.tsx:114-115
>>> QUOTE
  const canSaveDraft =
    !isBusy && (composeTo.trim() + composeSubject.trim() + composeBody.trim()).length > 0;
>>> END QUOTE

## INV-3
File: src/client/bridge/client-bridge.ts:677-680
>>> QUOTE
      case WsMessageType.RESP_MAIL_SENT: {
        const resp = msg as WsRespMailSent;
        if (resp.success) {
          mail.clearCompose();
>>> END QUOTE

## INV-4
File: src/client/bridge/client-bridge.ts:687
>>> QUOTE
          mail.setSending(false);
>>> END QUOTE

## INV-5
File: src/server/session/mail-handler.ts:146-148
>>> QUOTE
  // Post returns wordbool: #-1 = true (success), #0 = false (failure)
  const resultStr = parsePropertyResponseHelper(postPacket.payload!, 'Post');
  const success = resultStr === '-1';
>>> END QUOTE

## INV-6
File: src/server/ws-handlers/mail-handlers.ts:61
>>> QUOTE
    message: success ? 'Message sent' : 'Failed to send message',
>>> END QUOTE

## INV-7
File: src/client/components/common/Toast.tsx:75
>>> QUOTE
export function showToast(message: string, variant: ToastVariant = 'info', iconOrOptions?: ReactNode | ToastOptions): string {
>>> END QUOTE

## INV-8
File: src/client/components/common/index.ts:2
>>> QUOTE
export { ToastContainer, showToast } from './Toast';
>>> END QUOTE
