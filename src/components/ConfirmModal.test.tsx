import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmModal open={false} message="Are you sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Are you sure?')).toBeNull();
  });

  it('renders the message and default confirm/cancel labels when open', () => {
    render(<ConfirmModal open={true} message="Are you sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    expect(screen.getByText('common.confirm')).toBeInTheDocument();
    expect(screen.getByText('common.cancel')).toBeInTheDocument();
  });

  // role="alertdialog" + aria-modal="true" with nothing naming it: a screen
  // reader announces "dialog" and the question itself is never read, so the
  // user is asked to confirm something they were not told. ModalShell has
  // taken a labelledBy since it was written — this just never passed one.
  it('names itself with its own message', () => {
    render(<ConfirmModal open={true} message="Leave the room?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const dialog = screen.getByRole('alertdialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)).toHaveTextContent('Leave the room?');
    expect(dialog).toHaveAccessibleName('Leave the room?');
  });

  it('gives two open dialogs distinct label ids', () => {
    // Hardcoding an id would collide the moment two dialogs are mounted at
    // once (the end-game confirm over a lobby one), and both would then be
    // announced with whichever message rendered first.
    render(
      <>
        <ConfirmModal open={true} message="First question?" onConfirm={vi.fn()} onCancel={vi.fn()} />
        <ConfirmModal open={true} message="Second question?" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>
    );

    const [a, b] = screen.getAllByRole('alertdialog');
    expect(a.getAttribute('aria-labelledby')).not.toBe(b.getAttribute('aria-labelledby'));
    expect(a).toHaveAccessibleName('First question?');
    expect(b).toHaveAccessibleName('Second question?');
  });

  it('uses custom confirm/cancel labels when provided', () => {
    render(
      <ConfirmModal
        open={true}
        message="Leave?"
        confirmLabel="game.controls.leaveGame"
        cancelLabel="common.cancel"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('game.controls.leaveGame')).toBeInTheDocument();
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal open={true} message="Are you sure?" onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText('common.confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} message="Are you sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the backdrop is clicked, but not when the dialog card itself is clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} message="Are you sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('alertdialog').parentElement!);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape is pressed', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} message="Are you sure?" onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  describe('focus management', () => {
    // A stateful wrapper — a real trigger button, plus an open/close cycle
    // driven by the same onCancel callback a real caller wires up (GameControls,
    // Home, OnlineLobby), rather than toggling the `open` prop directly.
    function Wrapper() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Trigger</button>
          <ConfirmModal
            open={open}
            message="Are you sure?"
            onConfirm={vi.fn()}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    it('moves focus into the dialog (onto Cancel) when opened, and back to the trigger when closed', async () => {
      render(<Wrapper />);
      const trigger = screen.getByText('Trigger');
      trigger.focus();
      expect(trigger).toHaveFocus();

      fireEvent.click(trigger);
      await waitFor(() => {
        expect(screen.getByText('common.cancel')).toHaveFocus();
      });

      fireEvent.click(screen.getByText('common.cancel'));
      await waitFor(() => {
        expect(trigger).toHaveFocus();
      });
    });

    it('responds to Escape via real focus, not just a manually targeted event — the bug the manually-targeted test above would miss', async () => {
      render(<Wrapper />);
      fireEvent.click(screen.getByText('Trigger'));
      await waitFor(() => {
        expect(screen.getByText('common.cancel')).toHaveFocus();
      });

      // Dispatched on whatever currently has focus (not on the dialog
      // directly) — this is what a real keypress targets, and is exactly
      // the case the earlier Escape test (fireEvent.keyDown on the dialog
      // itself) doesn't actually exercise.
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByText('Are you sure?')).toBeNull();
      });
    });

    it('wraps Tab focus between the two buttons instead of letting it escape the dialog', () => {
      render(<ConfirmModal open={true} message="Are you sure?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
      const cancelBtn = screen.getByText('common.cancel');
      const confirmBtn = screen.getByText('common.confirm');

      fireEvent.keyDown(cancelBtn, { key: 'Tab', shiftKey: true });
      expect(confirmBtn).toHaveFocus();

      fireEvent.keyDown(confirmBtn, { key: 'Tab' });
      expect(cancelBtn).toHaveFocus();
    });
  });
});
