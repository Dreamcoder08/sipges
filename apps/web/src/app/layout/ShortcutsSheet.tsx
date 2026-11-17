import { Fragment, useId } from 'react';
import { Sheet } from '../../shared/ui/Sheet.tsx';
import { SHORTCUT_GROUPS, comboText } from './shortcuts.ts';
import styles from './ShortcutsSheet.module.css';

/**
 * Every keyboard shortcut of the app, opened with Ctrl/⌘+/ or from the account menu
 * (chat-first-ui T14). It renders `shortcuts.ts`, the single list, group by group; the sheet
 * closes with Esc and gives focus back to whatever opened it.
 */
export const ShortcutsSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const ids = useId();
  return (
    <Sheet open={open} onClose={onClose} title="Atajos de teclado">
      {SHORTCUT_GROUPS.map((group, index) => (
        <section key={group.title} aria-labelledby={`${ids}-${index}`} className={styles.group}>
          <h3 id={`${ids}-${index}`}>{group.title}</h3>
          <dl>
            {group.items.map((item) => (
              <div key={item.label} className={styles.row}>
                <dt>{item.label}</dt>
                <dd>
                  {item.keys.map((combo, at) => (
                    <Fragment key={comboText(combo)}>
                      {at > 0 ? ' o ' : null}
                      <kbd>{comboText(combo)}</kbd>
                    </Fragment>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
};
