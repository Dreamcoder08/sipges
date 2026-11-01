# UI components

Prefer proven, maintained primitives for generic controls such as dialogs. Keep domain-specific behavior in SIPGES, and adapt the primitive to existing CSS Modules and design tokens. Adopt components when a feature needs them; do not rewrite the application wholesale. See [architecture guardrails](architecture-guardrails.md) for UI roles and token policy.

## Search dialog provenance

The search palette uses the Dialog component adapted from [shadcn/ui New York v4 Dialog source](https://github.com/shadcn-ui/ui/blob/c257f688cf4de7ec10cc1be84cad29cd4631182c/apps/v4/registry/new-york-v4/ui/dialog.tsx), backed by `@radix-ui/react-dialog`. The source reference is pinned to upstream commit `c257f688cf4de7ec10cc1be84cad29cd4631182c`. The local adaptation retains the named Dialog, Trigger, Portal, Overlay, Content and Title parts, replaces Tailwind styles with CSS Modules, and omits unused parts and the optional close icon. Search retains its existing keyboard and domain behavior. The overlay is a presentational `div` rather than Radix Overlay: Radix's scroll-lock helper injects a stylesheet that conflicts with SIPGES's strict CSP. Static CSS locks body scrolling while the overlay exists; Radix Content still owns focus trapping and dismissal. Do not weaken CSP to accommodate component defaults.

## Confirmation dialog

`ConfirmDialog` reuses the same local Dialog and adds a Description part. It applies alert-dialog rules without adding `@radix-ui/react-alert-dialog`, which is a thin layer over the same primitive:

- `role="alertdialog"`, labelled by its title and described by its message;
- focus starts on «Cancelar»;
- backdrop clicks never dismiss it;
- Escape cancels unless the action is pending.

Radix restores focus only to its own `DialogTrigger`. Consumers open the dialog from their own buttons, so `ConfirmDialog` records the opener and restores focus to it on close. `ConfirmDialog.test.tsx` covers this behavior, including the absence of injected style elements.

`Sheet` intentionally keeps its own implementation. It already uses native `inert`, scroll locking and focus return, and its drag-to-dismiss gesture is domain-specific. Migrating it would add risk without reducing meaningful complexity.

shadcn/ui is copyright shadcn and contributors and distributed under the [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md). Radix UI is a separate dependency; its version is pinned in `apps/web/package.json` and the lockfile.

### shadcn/ui license notice

```text
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
