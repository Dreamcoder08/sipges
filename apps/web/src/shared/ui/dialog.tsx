// Adapted from shadcn/ui's New York v4 Dialog; see docs/architecture/ui-components.md.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';

function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

// Radix Overlay injects scroll-lock styles, which the application's strict CSP rejects.
// Keep the overlay presentational; the CSS module owns scroll locking.
function DialogOverlay({ style, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-overlay" {...props} style={{ pointerEvents: 'auto', ...style }} />;
}

function DialogContent({
  children,
  overlayClassName,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { overlayClassName?: string | undefined }) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content data-slot="dialog-content" {...props}>
        {children}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogTitle(props: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

export { Dialog, DialogContent, DialogTitle, DialogTrigger };
