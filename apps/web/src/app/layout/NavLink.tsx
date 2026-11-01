import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Icon } from '../../shared/ui/Icon.tsx';
import type { IconName } from '../../shared/ui/icons.ts';
import { type NavPath, iconFor, labelFor } from '../navigation.ts';
import styles from './AppShell.module.css';

/**
 * A navigation link with its icon; the current screen is marked for styles and assistive tech.
 * A destination passes `current` because it is also current on the old screens it absorbs.
 */
export const NavLink = ({
  path,
  label,
  icon,
  current,
  className,
  onNavigate,
  role,
  tabIndex,
  children,
}: {
  path: NavPath;
  /** Shown instead of the screen's own name, e.g. «Integraciones» for Automatizaciones. */
  label?: string;
  icon?: IconName;
  current?: boolean;
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
    {...(current ? { 'aria-current': 'page' as const } : {})}
    {...(role ? { role } : {})}
    {...(tabIndex === undefined ? {} : { tabIndex })}
  >
    <Icon name={icon ?? iconFor(path)} className={styles.icon} />
    <span className={styles.text}>{label ?? labelFor(path)}</span>
    {children}
  </Link>
);
