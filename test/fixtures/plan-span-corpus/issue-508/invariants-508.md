# Invariants — task 508

Facts about the existing code the plan relies on. The Reply block (INV-1) is the one the implementer edits; the other three must stay untouched.

## INV-1
File: src/client/components/mail/MailPanel.tsx:236-245
>>> QUOTE
              {/* A draft is unsent, so there is nobody to reply to — it is re-opened for editing. */}
              {currentFolder === 'Draft' ? (
                <button className={styles.actionBtn} onClick={() => startEditDraft(currentMessage)} aria-label="Edit draft" title="Edit draft">
                  <PenSquare size={14} aria-hidden="true" />
                </button>
              ) : (
                <button className={styles.actionBtn} onClick={() => startReply(currentMessage)} aria-label="Reply" title="Reply">
                  <Reply size={14} aria-hidden="true" />
                </button>
              )}
>>> END QUOTE

## INV-2
File: src/client/components/mail/MailPanel.tsx:246-248
>>> QUOTE
              <button className={styles.actionBtn} onClick={handleDelete} aria-label="Delete" title="Delete">
                <Trash2 size={14} aria-hidden="true" />
              </button>
>>> END QUOTE

## INV-3
File: src/shared/types/domain-types.ts:760
>>> QUOTE
  noReply: boolean;      // true=system message, no reply allowed
>>> END QUOTE

## INV-4
File: src/server/session/mail-handler.ts:112
>>> QUOTE
    noReply: headers['NoReply'] === '1',
>>> END QUOTE

## INV-5
File: src/client/components/__tests__/mail-compose-integration.test.tsx:282-292
>>> QUOTE
    it('a message outside Drafts still offers Reply', () => {
      const msg: MailMessageFull = {
        messageId: 'msg-1', from: 'Alice', fromAddr: 'alice', to: 'Me', toAddr: 'me',
        subject: 'Hello', date: '2025-01-15', dateFmt: 'Jan 15',
        body: ['hi'], read: true, stamp: 3, noReply: false, attachments: [],
      };
      renderWithProviders(<MailPanel />);
      act(() => useMailStore.getState().setCurrentMessage(msg));
      expect(screen.getByRole('button', { name: 'Reply' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Edit draft' })).toBeNull();
    });
>>> END QUOTE
