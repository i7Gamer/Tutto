import { render, screen, fireEvent } from '@testing-library/react';
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
});
