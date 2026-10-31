import type { ComponentProps } from 'react';
import styles from './Button.module.css';

type Props = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

/** The one button primitive: four intents, two densities, 44px targets on touch screens. */
export const Button = ({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...props
}: Props) => (
  <button
    type={type}
    className={[styles.button, styles[variant], size === 'sm' ? styles.sm : '', className]
      .filter(Boolean)
      .join(' ')}
    {...props}
  />
);
