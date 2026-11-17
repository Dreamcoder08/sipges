import { createContext, type MouseEvent, type ReactNode, useContext } from 'react';

/**
 * In-app navigation for features, which never import the router (docs/adr/0006): the app
 * shell provides `navigate`, and InternalLink stays a real link for new tabs and crawlers.
 */
const NavigateContext = createContext<((href: string) => void) | null>(null);

export const NavigateProvider = NavigateContext.Provider;

export const useInternalNavigate = () => {
  const navigate = useContext(NavigateContext);
  return (href: string) => (navigate ? navigate(href) : window.location.assign(href));
};

/** The 360° view of one record (docs/adr/0011). */
export const objectHref = (module: string, id: string) =>
  `/objeto/${encodeURIComponent(module)}/${encodeURIComponent(id)}`;

/** The Territorio map focused on one record, which it selects and frames when it opens. */
export const mapHref = (module: string, id: string) =>
  `/territorio?vista=mapa&registro=${encodeURIComponent(`${module}:${id}`)}`;

export const InternalLink = ({
  href,
  className,
  children,
  'aria-label': label,
}: {
  href: string;
  className?: string | undefined;
  children: ReactNode;
  'aria-label'?: string;
}) => {
  const navigate = useContext(NavigateContext);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigate || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };
  return (
    <a href={href} className={className} aria-label={label} onClick={onClick}>
      {children}
    </a>
  );
};
