import { SCREEN_ICONS, type ScreenPath } from '../../../app/navigation.ts';
import { Icon } from '../../../shared/ui/Icon.tsx';
import { MODULES, type RecordModule } from '../modules.ts';
import { HUB_TYPES } from './types.ts';
import styles from './Hub.module.css';

/** The record type as a small chip with the same icon its screen had in the menu. */
export const TypeChip = ({ module }: { module: RecordModule }) => (
  <span className={styles.typeChip} data-type-chip>
    <Icon name={SCREEN_ICONS[`/${module}` as ScreenPath] ?? 'layers'} />
    {HUB_TYPES.find(([type]) => type === module)?.[1] ?? MODULES[module].label}
  </span>
);
