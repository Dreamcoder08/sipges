import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import { SCREEN_ICONS, labelFor } from '../navigation.ts';
import styles from './AppShell.module.css';

/** A navigation link with its icon; the current screen is marked for styles and assistive tech. */
export const NavLink = ({
  path,
  className,
  onNavigate,
  role,
  tabIndex,
  children,
}: {
  path: keyof typeof SCREEN_ICONS;
  className: string | undefined;
  onNavigate?: () => void;
  /** «menuitem» when the link sits in a menu that moves focus with the arrow keys. */
  role?: 'menuitem';
  tabIndex?: number;
  children?: ReactNode;
}) => (
  <Link
    to={path}
    className={className}
    activeOptions={{ exact: true }}
    onClick={onNavigate}
    activeProps={{ 'aria-current': 'page' }}
    {...(role ? { role } : {})}
    {...(tabIndex === undefined ? {} : { tabIndex })}
  >
    <Icon name={SCREEN_ICONS[path]} className={styles.icon} />
    <span className={styles.text}>{labelFor(path)}</span>
    {children}
  </Link>
);
