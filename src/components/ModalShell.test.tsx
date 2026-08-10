import { useRef, useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ModalShell from './ModalShell';

describe('ModalShell', () => {
  const Dialog = ({ open = true, ...props }: { open?: boolean; [key: string]: unknown }) => (
    <ModalShell open={open} {...props}>
      <button>first</button>
      <button>last</button>
    </ModalShell>
  );

  it('renders nothing while closed', () => {
    render(<Dialog open={false} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('announces itself as a modal dialog', () => {
    render(
      <>
        <h2 id="dialog-heading">Heading</h2>
        <Dialog labelledBy="dialog-heading" />
      </>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'dialog-heading');
  });

  it('can announce itself as an alert dialog instead', () => {
    render(<Dialog role="alertdialog" />);

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('moves focus into the panel on open', () => {
    render(<Dialog />);

    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('falls back to the panel when its content has nothing focusable yet', () => {
    // The dice panel opens with no buttons at all — they appear once the dice
    // have settled. Leaving focus on the trigger behind the backdrop means
    // Tab walks the page underneath and the panel's Tab trap never engages,
    // since it is a handler on the panel itself.
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    render(
      <ModalShell open>
        <p>rolling…</p>
      </ModalShell>
    );

    expect(screen.getByRole('dialog')).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });

  it('focuses the control the caller asks for', () => {
    const Host = () => {
      const lastRef = useRef<HTMLButtonElement>(null);
      return (
        <ModalShell open initialFocusRef={lastRef}>
          <button>first</button>
          <button ref={lastRef}>last</button>
        </ModalShell>
      );
    };
    render(<Host />);

    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('gives focus back to whatever had it when the dialog opened', async () => {
    const Host = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          <ModalShell open={open} onDismiss={() => setOpen(false)}>
            <button>inside</button>
          </ModalShell>
        </>
      );
    };
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'open' });
    trigger.focus();
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByRole('button', { name: 'inside' })).toHaveFocus());

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('gives focus back to returnFocusRef when the trigger cannot be inferred', async () => {
    // A dialog opened by something other than a click — a lost connection, a
    // restored session — leaves nothing focused to return to.
    const Host = () => {
      const [open, setOpen] = useState(true);
      const homeRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={homeRef}>home</button>
          <ModalShell open={open} returnFocusRef={homeRef} onDismiss={() => setOpen(false)}>
            <button>inside</button>
          </ModalShell>
        </>
      );
    };
    render(<Host />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'home' })).toHaveFocus());
  });

  it('leaves focus alone until it has actually been opened', () => {
    // Several of these sit mounted-but-closed in the app at once. If a closed
    // one reached for focus, the last one mounted would take it off whatever
    // the page had legitimately focused — including an open dialog.
    const Host = () => {
      const homeRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button>elsewhere</button>
          <button ref={homeRef}>would-be-return-target</button>
          <ModalShell open={false} returnFocusRef={homeRef}>
            <button>inside</button>
          </ModalShell>
        </>
      );
    };
    render(<Host />);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    elsewhere.focus();

    expect(elsewhere).toHaveFocus();
  });

  it('dismisses on Escape and on a click outside the panel', () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it('stays put when the panel itself is clicked', () => {
    const onDismiss = vi.fn();
    render(<Dialog onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('dialog'));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('cannot be dismissed when the caller offers no way out', () => {
    // A dialog reporting a state the player cannot walk away from — the lost
    // connection popup — has no dismiss of its own, so neither route may
    // silently close it.
    render(<Dialog />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('modal-backdrop'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps Tab inside the panel', () => {
    render(<Dialog />);
    const first = screen.getByRole('button', { name: 'first' });
    const last = screen.getByRole('button', { name: 'last' });

    last.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});
