# UI components

Prefer proven, maintained primitives for generic controls such as dialogs. Keep domain-specific behavior in MASCLI, and adapt the primitive to existing CSS Modules and design tokens. Adopt components when a feature needs them; do not rewrite the application wholesale.

## Search dialog provenance

The search palette uses the Dialog component adapted from [shadcn/ui New York v4 Dialog source](https://github.com/shadcn-ui/ui/blob/c257f688cf4de7ec10cc1be84cad29cd4631182c/apps/v4/registry/new-york-v4/ui/dialog.tsx), backed by `@radix-ui/react-dialog`. The source reference is pinned to upstream commit `c257f688cf4de7ec10cc1be84cad29cd4631182c`. The local adaptation retains the named Dialog, Trigger, Portal, Overlay, Content and Title parts, replaces Tailwind styles with CSS Modules, and omits unused parts and the optional close icon. Search retains its existing keyboard and domain behavior. The overlay is a presentational `div` rather than Radix Overlay: Radix's scroll-lock helper injects a stylesheet that conflicts with MASCLI's strict CSP. Static CSS locks body scrolling while the overlay exists; Radix Content still owns focus trapping and dismissal. Do not weaken CSP to accommodate component defaults.

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
