import type { ButtonHTMLAttributes } from 'react';
import styles from './Button.module.css';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
};

export const Button = ({ variant = 'primary', type = 'button', className, ...props }: Props) => (
  <button
    type={type}
    className={[styles.button, styles[variant], className].filter(Boolean).join(' ')}
    {...props}
  />
);
